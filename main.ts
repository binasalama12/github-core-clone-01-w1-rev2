// Single-file forge, speed first.
//
// A GitHub-compatible git forge in one TypeScript file: git smart HTTP
// (upload-pack protocol v2 + v0, receive-pack v0), the REST v3 API under
// /api/v3, GraphQL v4 at /api/graphql and an MCP endpoint at /mcp, all over
// one in-memory store. No dependencies beyond the Node standard library and
// no git binary: packs are parsed and built by hand.
//
// Speed rules honoured on the hot paths:
//   - pack ingest inflates every object with a single inflateSync call that
//     reports how many input bytes it consumed (never a length search);
//   - fast-forward checks walk ancestry depth-first and stop the moment the
//     ancestor is found (never a full ancestor set per push);
//   - every stored object is hashed exactly once, when it is stored;
//   - request handlers do work proportional to the request, not the repo.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, type Hash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Lifecycle constants and the single user
// ---------------------------------------------------------------------------

const VIEWER_LOGIN = 'adaiversen';
const VIEWER_ID = 1000;
const ZERO_OID = '0000000000000000000000000000000000000000';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EPOCH_BASE = 1735689600; // 2025-01-01T00:00:00Z; our own clock for stamps we mint

let stampCounter = 0;
/** A deterministic, strictly increasing timestamp for objects we create. */
function nextStamp(): { epoch: number; iso: string } {
  stampCounter += 1;
  const epoch = EPOCH_BASE + stampCounter;
  return { epoch, iso: new Date(epoch * 1000).toISOString() };
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type GitType = 'commit' | 'tree' | 'blob' | 'tag';

interface StoredObject {
  type: GitType;
  data: Buffer;
}

interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string; // short branch name
  baseRef: string; // short branch name
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, StoredObject>;
  refs: Map<string, string>; // full ref name -> oid
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number; // issues and pulls share one sequence, as on GitHub
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  nextLabelId: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

function createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
  const stamp = nextStamp();
  globalSeq += 1;
  const repo: Repo = {
    id: nextRepoId,
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: defaultBranch || 'main',
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextIssueId: 1,
    nextPullId: 1,
    nextCommentId: 1,
    nextLabelId: 1,
    seq: globalSeq,
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// ---------------------------------------------------------------------------
// Git object core: hashing (once, at store time), parsing, tree walking
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a payload: sha1 of "<type> <len>\0" + data. */
function objectId(type: GitType, data: Buffer): string {
  const hash: Hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object, hashing it exactly once. Returns its id. */
function storeObject(repo: Repo, type: GitType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  time: number;
}

const commitCache = new Map<string, ParsedCommit | null>();

function parseCommit(repo: Repo, oid: string): ParsedCommit | null {
  const cached = commitCache.get(oid);
  if (cached !== undefined) return cached;
  let parsed: ParsedCommit | null = null;
  const obj = repo.objects.get(oid);
  if (obj !== undefined && obj.type === 'commit') {
    const text = obj.data.toString('utf8');
    const split = text.indexOf('\n\n');
    const head = split === -1 ? text : text.slice(0, split);
    const message = split === -1 ? '' : text.slice(split + 2);
    let tree = ZERO_OID;
    const parents: string[] = [];
    let time = 0;
    for (const line of head.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
      else if (line.startsWith('committer ')) {
        const match = / (\d+) [+-]\d{4}$/.exec(line);
        if (match !== null) time = Number(match[1]);
      }
    }
    parsed = { tree, parents, message, time };
  }
  commitCache.set(oid, parsed);
  return parsed;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const treeCache = new Map<string, TreeEntry[] | null>();

function parseTree(repo: Repo, oid: string): TreeEntry[] {
  const cached = treeCache.get(oid);
  if (cached !== undefined) return cached ?? [];
  let entries: TreeEntry[] | null = null;
  const obj = repo.objects.get(oid);
  if (obj !== undefined && obj.type === 'tree') {
    entries = [];
    const data = obj.data;
    let pos = 0;
    while (pos < data.length) {
      const space = data.indexOf(0x20, pos);
      if (space === -1) break;
      const mode = data.toString('ascii', pos, space);
      const nul = data.indexOf(0x00, space + 1);
      if (nul === -1 || nul + 21 > data.length) break;
      const name = data.toString('utf8', space + 1, nul);
      const entryOid = data.toString('hex', nul + 1, nul + 21);
      entries.push({ mode, name, oid: entryOid });
      pos = nul + 21;
    }
  }
  treeCache.set(oid, entries);
  return entries ?? [];
}

/** Build (and store) a tree object from sorted entries; returns its id. */
function buildTree(repo: Repo, entries: TreeEntry[]): string {
  const sorted = entries.slice().sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

interface FlatEntry {
  mode: string;
  oid: string;
}

const flatCache = new Map<string, Map<string, FlatEntry>>();

/** Flatten a tree (recursively) into a path -> entry map. Cached per tree id. */
function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const cached = flatCache.get(treeOid);
  if (cached !== undefined) return cached;
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    for (const entry of parseTree(repo, oid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (treeOid !== ZERO_OID && repo.objects.has(treeOid)) walk(treeOid, '');
  flatCache.set(treeOid, out);
  return out;
}

/** Rebuild nested tree objects from a flattened path map; returns the root tree id. */
function treeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Array<{ name: string; mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1] as string, mode: entry.mode, oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const file of node.files) entries.push({ mode: file.mode, name: file.name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return buildTree(repo, entries);
  };
  return build(root);
}

/** Create (and store) a commit object; returns its id. */
function makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const stamp = nextStamp();
  const ident = `Ada Iversen <ada@example.invalid> ${stamp.epoch} +0000`;
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return storeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

/** Peel a tag object chain down to the object it ultimately names. */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return current;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (match === null || match[1] === undefined) return current;
    current = match[1];
  }
  return current;
}

/**
 * Early-exit ancestry test: depth-first from `descendant`, stopping the
 * moment `ancestor` is found. Never materialises a full ancestor set.
 */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = parseCommit(repo, current);
    if (commit === null) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return false;
}

/** The first common ancestor of two commits (breadth-first from both), or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsOfA = new Set<string>();
  const stackA: string[] = [a];
  while (stackA.length > 0) {
    const current = stackA.pop() as string;
    if (ancestorsOfA.has(current)) continue;
    ancestorsOfA.add(current);
    const commit = parseCommit(repo, current);
    if (commit !== null) for (const parent of commit.parents) stackA.push(parent);
  }
  const seenB = new Set<string>();
  const queueB: string[] = [b];
  while (queueB.length > 0) {
    const current = queueB.shift() as string;
    if (seenB.has(current)) continue;
    seenB.add(current);
    if (ancestorsOfA.has(current)) return current;
    const commit = parseCommit(repo, current);
    if (commit !== null) for (const parent of commit.parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse a whole pkt-line stream (request bodies are fully buffered). */
function parsePkts(body: Buffer, start: number): { packets: PktPacket[]; rest: number } {
  const packets: PktPacket[] = [];
  let pos = start;
  while (pos + 4 <= body.length) {
    const header = body.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      break; // a flush ends the command section; what follows is raw (a pack)
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > body.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: body.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, rest: pos };
}

// ---------------------------------------------------------------------------
// Pack ingest: one inflate call per object, deltas resolved in memory
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, GitType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

interface PackEntry {
  offset: number;
  kind: GitType | 'ofs-delta' | 'ref-delta';
  data: Buffer; // inflated payload (the object body, or the delta program)
  baseOffset: number; // for ofs-delta
  baseOid: string; // for ref-delta
}

/** Apply a git delta program to a base payload. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size (the caller trusts the pack)
  const resultSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos] as number; pos += 1; }
      if (op & 0x02) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x04) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if (op & 0x08) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos] as number; pos += 1; }
      if (op & 0x20) { size |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x40) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks, produced);
  if (out.length !== resultSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Ingest one pack into the repo store. Every entry is inflated with exactly
 * one inflateSync call whose engine reports the consumed byte count, so the
 * walk never guesses lengths. Returns the number of objects stored.
 */
function ingestPack(repo: Repo, pack: Buffer): number {
  if (pack.length < 12 + 20) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack has no PACK signature');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  for (let i = 0; i < count; i += 1) {
    const offset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeNum = (byte >> 4) & 0x07;
    // the declared size is not needed: the inflated payload is authoritative
    while (byte & 0x80) {
      byte = pack[pos] as number;
      pos += 1;
    }
    const kind = PACK_TYPES[typeNum];
    if (kind === undefined) throw new Error(`unknown pack object type ${typeNum}`);
    let baseOffset = 0;
    let baseOid = '';
    if (kind === 'ofs-delta') {
      let b = pack[pos] as number;
      pos += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos] as number;
        pos += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = offset - back;
    } else if (kind === 'ref-delta') {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    // ONE inflate call for this entry: the engine says how far it read.
    const inflated = inflateSync(pack.subarray(pos), { info: true });
    const data = Buffer.from(inflated.buffer);
    pos += inflated.engine.bytesWritten;
    const entry: PackEntry = { offset, kind, data, baseOffset, baseOid };
    entries.push(entry);
    byOffset.set(offset, entry);
  }
  // Resolve deltas (memoised recursion), then store each object once.
  const resolved = new Map<number, { type: GitType; data: Buffer }>();
  const resolveEntry = (entry: PackEntry): { type: GitType; data: Buffer } => {
    const memo = resolved.get(entry.offset);
    if (memo !== undefined) return memo;
    let out: { type: GitType; data: Buffer };
    if (entry.kind === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolveEntry(baseEntry);
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.kind === 'ref-delta') {
      let baseData: Buffer | null = null;
      let baseType: GitType | null = null;
      for (const candidate of entries) {
        if (candidate.kind !== 'ofs-delta' && candidate.kind !== 'ref-delta') {
          if (objectId(candidate.kind, candidate.data) === entry.baseOid) {
            baseData = candidate.data;
            baseType = candidate.kind;
            break;
          }
        }
      }
      if (baseData === null) {
        const stored = repo.objects.get(entry.baseOid);
        if (stored !== undefined) {
          baseData = stored.data;
          baseType = stored.type;
        }
      }
      if (baseData === null || baseType === null) throw new Error('ref-delta base is not available');
      out = { type: baseType, data: applyDelta(baseData, entry.data) };
    } else {
      out = { type: entry.kind, data: entry.data };
    }
    resolved.set(entry.offset, out);
    return out;
  };
  for (const entry of entries) {
    const full = resolveEntry(entry);
    storeObject(repo, full.type, full.data);
  }
  return entries.length;
}

// ---------------------------------------------------------------------------
// Pack generation (plain objects, no deltas: small and fast to build)
// ---------------------------------------------------------------------------

function packEntryHeader(type: GitType, size: number): Buffer {
  const typeNum = { commit: 1, tree: 2, blob: 3, tag: 4 }[type];
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

function buildPack(repo: Repo, oids: Iterable<string>): Buffer {
  const list = [...oids].filter((oid) => repo.objects.has(oid));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = repo.objects.get(oid) as StoredObject;
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Fetch computation: what a want/have/deepen request must transfer
// ---------------------------------------------------------------------------

interface FetchPlan {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
  common: string[]; // haves the server holds (for ACK lines)
}

function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
  deepenNot: string[],
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Everything the client already holds: the closure of its haves, except
  // that a shallow boundary's parents are NOT held (the client lacks them).
  const held = new Set<string>();
  const heldCommits = new Set<string>();
  const stack: string[] = [];
  for (const have of haves) if (repo.objects.has(have)) stack.push(have);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    held.add(oid);
    if (obj.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target !== oid) stack.push(target);
      continue;
    }
    if (obj.type === 'tree') {
      for (const entry of parseTree(repo, oid)) stack.push(entry.oid);
      continue;
    }
    if (obj.type !== 'commit') continue;
    heldCommits.add(oid);
    const commit = parseCommit(repo, oid);
    if (commit === null) continue;
    stack.push(commit.tree);
    if (!shallowSet.has(oid)) for (const parent of commit.parents) stack.push(parent);
  }
  for (const not of deepenNot) {
    // deepen-not roots: treat their whole ancestry as held for exclusion
    const inner: string[] = [not];
    while (inner.length > 0) {
      const oid = inner.pop() as string;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTree(repo, oid)) inner.push(entry.oid);
      }
      if (obj.type === 'commit') {
        heldCommits.add(oid);
        const commit = parseCommit(repo, oid);
        if (commit !== null) {
          inner.push(commit.tree);
          for (const parent of commit.parents) inner.push(parent);
        }
      }
    }
  }

  const maxGen = depth === null ? Number.POSITIVE_INFINITY : depth - 1;
  const send = new Set<string>();
  const sentCommits = new Set<string>();
  // Breadth-first by generation from every want.
  let frontier: string[] = [];
  const genOf = new Map<string, number>();
  for (const want of wants) {
    if (!repo.objects.has(want)) continue;
    const obj = repo.objects.get(want) as StoredObject;
    if (obj.type === 'tag') {
      if (!held.has(want)) send.add(want);
      const target = peelToCommit(repo, want);
      if (!genOf.has(target)) {
        genOf.set(target, 0);
        frontier.push(target);
      }
    } else if (obj.type === 'commit') {
      if (!genOf.has(want)) {
        genOf.set(want, 0);
        frontier.push(want);
      }
    } else if (!held.has(want)) {
      send.add(want);
    }
  }
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      const gen = genOf.get(oid) as number;
      if (gen > maxGen) continue;
      const commit = parseCommit(repo, oid);
      if (commit === null) continue;
      if (!held.has(oid)) {
        send.add(oid);
        sentCommits.add(oid);
        // the commit's whole tree, minus what the client holds
        const treeStack: string[] = [commit.tree];
        while (treeStack.length > 0) {
          const treeOid = treeStack.pop() as string;
          if (held.has(treeOid) || send.has(treeOid)) continue;
          const treeObj = repo.objects.get(treeOid);
          if (treeObj === undefined) continue;
          send.add(treeOid);
          for (const entry of parseTree(repo, treeOid)) treeStack.push(entry.oid);
        }
      }
      if (gen < maxGen) {
        const expandable = !heldCommits.has(oid) || shallowSet.has(oid);
        if (expandable) {
          for (const parent of commit.parents) {
            if (!genOf.has(parent)) {
              genOf.set(parent, gen + 1);
              next.push(parent);
            }
          }
        }
      }
    }
    frontier = next;
  }

  const shallow: string[] = [];
  for (const oid of sentCommits) {
    const commit = parseCommit(repo, oid);
    if (commit === null || commit.parents.length === 0) continue;
    const cutOff = commit.parents.some((parent) => !sentCommits.has(parent) && !heldCommits.has(parent));
    if (cutOff) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const commit = parseCommit(repo, oid);
    if (commit === null) continue;
    if (commit.parents.length > 0 && commit.parents.every((parent) => sentCommits.has(parent) || heldCommits.has(parent))) {
      unshallow.push(oid);
    }
  }
  const common = haves.filter((have) => repo.objects.has(have));
  return { send, shallow, unshallow, common };
}

/** Wrap pack bytes in side-band-64k pkt-lines (band 1), with a final flush. */
function sidebandWrap(pack: Buffer, includePack: boolean): Buffer {
  const parts: Buffer[] = [];
  if (includePack) {
    const CHUNK = 65515;
    for (let pos = 0; pos < pack.length; pos += CHUNK) {
      const chunk = pack.subarray(pos, pos + CHUNK);
      const framed = Buffer.alloc(chunk.length + 1);
      framed[0] = 1;
      chunk.copy(framed, 1);
      parts.push(pktLine(framed));
    }
    if (pack.length === 0) {
      parts.push(pktLine(Buffer.from([1])));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 ref advertisement body for a service, preamble included. */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0'
      : `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0 symref=HEAD:${headTarget(repo)} object-format=sha1`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    let first = true;
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    const headLine = `${headOid} HEAD`;
    parts.push(pktLine(first ? `${headLine}\0${caps}` : headLine));
    first = false;
    for (const name of names) {
      const oid = repo.refs.get(name) as string;
      parts.push(pktLine(`${oid} ${name}`));
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

function handleInfoRefs(repo: Repo, service: string, isV2: boolean, res: ServerResponse): void {
  if (service === 'git-upload-pack') {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' });
    res.end(isV2 ? v2Advertisement() : v0Advertisement(repo, service));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'cache-control': 'no-cache' });
  res.end(v0Advertisement(repo, 'git-receive-pack'));
}

/** One ls-refs (protocol v2) exchange. */
function handleLsRefs(repo: Repo, packets: PktPacket[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  const headWanted = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(Buffer.concat(parts));
}

/** A fetch exchange, protocol v2 (sections) or v0 (sideband after NAK). */
function handleFetch(repo: Repo, packets: PktPacket[], extraPackets: PktPacket[], isV2: boolean, res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | null = null;
  const all = [...packets, ...extraPackets];
  for (const packet of all) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice('deepen-not '.length).trim());
  }
  const plan = computeFetch(repo, wants, haves, clientShallow, depth, deepenNot);
  const pack = buildPack(repo, plan.send);
  if (isV2) {
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (plan.common.length > 0) {
      for (const common of plan.common) parts.push(pktLine(`ACK ${common}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    const CHUNK = 65515;
    for (let pos = 0; pos < pack.length; pos += CHUNK) {
      const chunk = pack.subarray(pos, pos + CHUNK);
      const framed = Buffer.alloc(chunk.length + 1);
      framed[0] = 1;
      chunk.copy(framed, 1);
      parts.push(pktLine(framed));
    }
    parts.push(PKT_FLUSH);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    res.end(Buffer.concat(parts));
    return;
  }
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine(plan.common.length > 0 ? `ACK ${plan.common[0]}\n` : 'NAK\n'));
  const CHUNK = 65515;
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    const chunk = pack.subarray(pos, pos + CHUNK);
    const framed = Buffer.alloc(chunk.length + 1);
    framed[0] = 1;
    chunk.copy(framed, 1);
    parts.push(pktLine(framed));
  }
  parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(Buffer.concat(parts));
}

function handleUploadPack(repo: Repo, body: Buffer, res: ServerResponse): void {
  try {
    const { packets, rest } = parsePkts(body, 0);
    const first = packets.find((packet) => packet.kind === 'data');
    const firstLine = first !== undefined ? first.payload.toString('utf8') : '';
    if (firstLine.startsWith('command=ls-refs')) {
      handleLsRefs(repo, packets, res);
      return;
    }
    if (firstLine.startsWith('command=fetch')) {
      handleFetch(repo, packets, [], true, res);
      return;
    }
    // Protocol v0: want lines, a flush, then have/done lines and a second flush.
    const second = parsePkts(body, rest);
    handleFetch(repo, packets, second.packets, false, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    res.end(Buffer.concat([pktLine(`ERR ${message}\n`), PKT_FLUSH]));
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  let commands: PushCommand[] = [];
  let capabilities = '';
  let packStart = body.length;
  try {
    const { packets, rest } = parsePkts(body, 0);
    packStart = rest;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      const fields = line.split(' ');
      if (fields.length >= 3) {
        commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
      }
    }
  } catch {
    commands = [];
    packStart = body.length;
  }
  const wantsPack = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packStart < body.length && body.toString('ascii', packStart, packStart + 4) === 'PACK') {
    try {
      ingestPack(repo, body.subarray(packStart));
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  } else if (wantsPack && packStart < body.length) {
    unpackOk = false;
    unpackDetail = 'no packfile followed the command list';
  }

  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObj = repo.objects.get(command.newOid);
    if (newObj === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && current === command.oldOid) {
      const oldCommit = peelToCommit(repo, command.oldOid);
      const newCommit = peelToCommit(repo, command.newOid);
      if (repo.objects.get(oldCommit)?.type === 'commit' && repo.objects.get(newCommit)?.type === 'commit') {
        if (!isAncestor(repo, oldCommit, newCommit)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!caps.has('report-status') && !caps.has('report-status-v2')) {
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
    res.end(Buffer.alloc(0));
    return;
  }
  const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  let out: Buffer;
  if (caps.has('side-band-64k')) {
    const wrapped: Buffer[] = [];
    const CHUNK = 65515;
    for (let pos = 0; pos < report.length; pos += CHUNK) {
      const chunk = report.subarray(pos, pos + CHUNK);
      const framed = Buffer.alloc(chunk.length + 1);
      framed[0] = 1;
      chunk.copy(framed, 1);
      wrapped.push(pktLine(framed));
    }
    wrapped.push(PKT_FLUSH);
    out = Buffer.concat(wrapped);
  } else {
    out = report;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
  res.end(out);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...extra,
  };
  if (text !== '') headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function gqlId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gqlId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://forge/${repo.owner}/${repo.name}`,
    url: `http://forge/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    watchers_count: 0,
    size: repo.objects.size,
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gqlId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label as LabelRec)),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `http://forge/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issue: IssueRec, comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gqlId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `http://forge/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headShaAtCreate;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseShaAtCreate;
  return {
    id: pull.id,
    node_id: gqlId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: { login: repo.owner, id: VIEWER_ID } },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: { login: repo.owner, id: VIEWER_ID } },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `http://forge/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `http://forge/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Resolve a branch name, full ref, or commit id to a commit oid. */
function resolveToCommit(repo: Repo, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return repo.refs.get(headTarget(repo)) ?? null;
  }
  if (ref === 'HEAD') return repo.refs.get(headTarget(repo)) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return peelToCommit(repo, byBranch);
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return peelToCommit(repo, byRef);
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.get(ref.toLowerCase())?.type === 'commit') return ref.toLowerCase();
  return null;
}

/** Commit one file change (or deletion when bytes is null) onto a branch. */
function commitFileChange(
  repo: Repo,
  branchName: string,
  path: string,
  bytes: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null; existed: boolean } | null {
  const refName = `refs/heads/${branchName}`;
  let tip = repo.refs.get(refName);
  if (tip === undefined && branchName !== repo.defaultBranch) {
    // A contents write to a fresh branch starts from the default branch tip.
    tip = repo.refs.get(headTarget(repo));
  }
  const tipCommit = tip !== undefined ? parseCommit(repo, peelToCommit(repo, tip)) : null;
  const flat = new Map<string, FlatEntry>();
  if (tipCommit !== null) {
    for (const [key, value] of flattenTree(repo, tipCommit.tree)) flat.set(key, value);
  }
  const existed = flat.has(path);
  let blobSha: string | null = null;
  if (bytes !== null) {
    blobSha = storeObject(repo, 'blob', bytes);
    flat.set(path, { mode: '100644', oid: blobSha });
  } else {
    flat.delete(path);
  }
  const tree = treeFromFlat(repo, flat);
  const parents = tip !== undefined ? [peelToCommit(repo, tip)] : [];
  const commitSha = makeCommit(repo, tree, parents, message);
  repo.refs.set(refName, commitSha);
  return { commitSha, blobSha, existed };
}

interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  headOid: string | null;
}

/** Line-level change counts by trimming the common prefix/suffix of lines. */
function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { additions: newEnd - start, deletions: oldEnd - start };
}

/** The file-level diff between two commits (by tree), or null when either is unknown. */
function diffCommits(repo: Repo, fromCommit: string | null, toCommit: string | null): FileChange[] {
  const fromFlat = fromCommit !== null ? flattenTree(repo, parseCommit(repo, fromCommit)?.tree ?? ZERO_OID) : new Map<string, FlatEntry>();
  const toFlat = toCommit !== null ? flattenTree(repo, parseCommit(repo, toCommit)?.tree ?? ZERO_OID) : new Map<string, FlatEntry>();
  const changes: FileChange[] = [];
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = fromFlat.get(path);
    const after = toFlat.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before !== undefined ? (repo.objects.get(before.oid)?.data.toString('utf8') ?? null) : null;
    const newText = after !== undefined ? (repo.objects.get(after.oid)?.data.toString('utf8') ?? null) : null;
    const counts = lineCounts(oldText, newText);
    changes.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      headOid: after?.oid ?? null,
    });
  }
  return changes;
}

/** The changed paths of a pull request: merge-base -> head tip. */
function pullChanges(repo: Repo, pull: PullRec): FileChange[] {
  const headTip = resolveToCommit(repo, pull.headRef);
  const baseTip = resolveToCommit(repo, pull.baseRef);
  if (headTip === null) return [];
  const base = baseTip !== null ? (mergeBase(repo, baseTip, headTip) ?? baseTip) : null;
  return diffCommits(repo, base, headTip);
}

/** Whether merging the pull right now would conflict (same path, both sides). */
function pullConflicts(repo: Repo, pull: PullRec): boolean {
  const headTip = resolveToCommit(repo, pull.headRef);
  const baseTip = resolveToCommit(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return false;
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null || base === headTip) return false;
  const headChanges = new Map(diffCommits(repo, base, headTip).map((change) => [change.filename, change.headOid]));
  const baseChanges = new Map(diffCommits(repo, base, baseTip).map((change) => [change.filename, change.headOid]));
  for (const [path, headOid] of headChanges) {
    if (baseChanges.has(path) && baseChanges.get(path) !== headOid) return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit id. */
function mergePull(repo: Repo, pull: PullRec): string | null {
  if (pullConflicts(repo, pull)) return null;
  const headTip = resolveToCommit(repo, pull.headRef);
  const baseTip = resolveToCommit(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return null;
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const headFlat = flattenTree(repo, parseCommit(repo, headTip)?.tree ?? ZERO_OID);
  const baseFlat = flattenTree(repo, parseCommit(repo, baseTip)?.tree ?? ZERO_OID);
  const mergedFlat = new Map(baseFlat);
  for (const change of diffCommits(repo, base, headTip)) {
    const entry = headFlat.get(change.filename);
    if (entry === undefined) mergedFlat.delete(change.filename);
    else mergedFlat.set(change.filename, entry);
  }
  const tree = treeFromFlat(repo, mergedFlat);
  const stamp = nextStamp();
  const sha = base === headTip && tree === (parseCommit(repo, baseTip)?.tree ?? '')
    ? baseTip
    : makeCommit(repo, tree, [baseTip], `Merge pull request #${pull.number} (squash)\n\n${pull.title}`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp.iso;
  pull.mergeCommitSha = sha;
  pull.updatedAt = stamp.iso;
  return sha;
}

function pageSlice<T>(items: T[], query: URLSearchParams): T[] {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return items.slice((page - 1) * perPage, page * perPage);
}

function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): void {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (!authed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  let body: Record<string, unknown> = {};
  if (rawBody.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
  }
  const segments = path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);

  if (rest.length === 0) {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', current_user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org, write:org' },
    );
    return;
  }
  if (rest[0] === 'meta' && rest.length === 1) {
    sendJson(res, 200, { installed_version: 'forge-1.0.0', hooks: [], git: [], pages: [], importer: [], actions: [], packages: [] });
    return;
  }
  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gqlId('User', VIEWER_ID), type: 'User', name: 'Ada Iversen', site_admin: false });
    return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') {
      const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const slice = mine.slice((page - 1) * perPage, page * perPage);
      const extra: Record<string, string> = {};
      if (page * perPage < mine.length) {
        const host = req.headers.host ?? 'localhost';
        const next = new URL(`http://${host}${path}`);
        next.searchParams.set('page', String(page + 1));
        next.searchParams.set('per_page', String(perPage));
        extra.link = `<${next.toString()}>; rel="next", <${next.toString()}>; rel="last"`;
      }
      sendJson(res, 200, slice.map((repo) => repoJson(repo)), extra);
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendError(res, 422, 'Repository creation failed.');
        return;
      }
      if (findRepo(VIEWER_LOGIN, name) !== null) {
        sendError(res, 422, 'Repository creation failed: the name already exists on this account');
        return;
      }
      const repo = createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        typeof body.private === 'boolean' ? body.private : false,
        typeof body.default_branch === 'string' ? body.default_branch : 'main',
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const name = rest[2] as string;
    const repo = owner === VIEWER_LOGIN ? findRepo(owner, name) : null;
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          repos.delete(repoKey(repo.owner, repo.name));
          repo.name = body.name;
          repos.set(repoKey(repo.owner, repo.name), repo);
        }
        repo.updatedAt = nextStamp().iso;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(repo.owner, repo.name));
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
    }

    // ----- contents API -----
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'GET') {
        const commit = resolveToCommit(repo, url.searchParams.get('ref'));
        if (commit === null) {
          // an unborn repository: only an empty root listing exists
          if (filePath === '') {
            sendJson(res, 200, []);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        const tree = parseCommit(repo, commit)?.tree ?? ZERO_OID;
        const flat = flattenTree(repo, tree);
        const file = flat.get(filePath);
        if (file !== undefined) {
          const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            size: data.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            sha: file.oid,
          });
          return;
        }
        // directory listing: walk the tree to the directory
        let dirTree = tree;
        let found = true;
        if (filePath !== '') {
          for (const part of filePath.split('/')) {
            const entry = parseTree(repo, dirTree).find((candidate) => candidate.name === part && candidate.mode === '40000');
            if (entry === undefined) {
              found = false;
              break;
            }
            dirTree = entry.oid;
          }
        }
        if (!found) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const entries = parseTree(repo, dirTree).map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        }));
        sendJson(res, 200, entries);
        return;
      }
      if (method === 'PUT') {
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const content = typeof body.content === 'string' ? body.content : '';
        const refName = `refs/heads/${branch}`;
        let tip = repo.refs.get(refName);
        if (tip === undefined && branch !== repo.defaultBranch) tip = repo.refs.get(headTarget(repo));
        const tipCommit = tip !== undefined ? parseCommit(repo, peelToCommit(repo, tip)) : null;
        const existing = tipCommit !== null ? flattenTree(repo, tipCommit.tree).get(filePath) : undefined;
        if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing.oid) {
          sendError(res, 409, 'Conflict: the file sha does not match the current content');
          return;
        }
        const result = commitFileChange(repo, branch, filePath, Buffer.from(content, 'base64'), message);
        if (result === null) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        sendJson(res, result.existed ? 200 : 201, {
          content: {
            type: 'file',
            encoding: 'base64',
            sha: result.blobSha,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
            size: Buffer.from(content, 'base64').length,
          },
          commit: { sha: result.commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const commit = resolveToCommit(repo, branch);
        const flat = commit !== null ? flattenTree(repo, parseCommit(repo, commit)?.tree ?? ZERO_OID) : new Map<string, FlatEntry>();
        const existing = flat.get(filePath);
        if (existing === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (typeof body.sha === 'string' && body.sha !== existing.oid) {
          sendError(res, 409, 'Conflict: the file sha does not match the current content');
          return;
        }
        const result = commitFileChange(repo, branch, filePath, null, message);
        sendJson(res, 200, { content: null, commit: { sha: result?.commitSha ?? '', message } });
        return;
      }
    }

    // ----- git refs and branches -----
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha.toLowerCase() : '';
        if (ref === '' || !repo.objects.has(sha)) {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        if (repo.refs.has(ref)) {
          sendError(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      if (method === 'GET' && tail.length >= 3) {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
        return;
      }
    }
    if (tail[0] === 'branches') {
      if (method === 'GET' && tail.length === 1) {
        const branches = sortedRefNames(repo)
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false }));
        sendJson(res, 200, pageSlice(branches, url.searchParams));
        return;
      }
      if (method === 'GET' && tail.length >= 2) {
        const branch = tail.slice(1).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (oid === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
        return;
      }
    }

    // ----- commits -----
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const start = resolveToCommit(repo, url.searchParams.get('sha'));
      const commits: Array<Record<string, unknown>> = [];
      if (start !== null) {
        const seen = new Set<string>();
        const stack: string[] = [start];
        while (stack.length > 0 && commits.length < 500) {
          const oid = stack.pop() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const parsed = parseCommit(repo, oid);
          if (parsed === null) continue;
          const raw = repo.objects.get(oid)?.data.toString('utf8') ?? '';
          const authorLine = /^author (.*)$/m.exec(raw)?.[1] ?? '';
          const ident = /^(.*) <(.*)> (\d+)/.exec(authorLine);
          const date = ident !== null ? new Date(Number(ident[3]) * 1000).toISOString() : repo.createdAt;
          commits.push({
            sha: oid,
            commit: {
              message: parsed.message,
              author: { name: ident?.[1] ?? '', email: ident?.[2] ?? '', date },
              committer: { name: ident?.[1] ?? '', email: ident?.[2] ?? '', date },
              tree: { sha: parsed.tree },
            },
            parents: parsed.parents.map((parent) => ({ sha: parent })),
          });
          for (const parent of parsed.parents) stack.push(parent);
        }
      }
      sendJson(res, 200, pageSlice(commits, url.searchParams));
      return;
    }

    // ----- labels -----
    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') {
          sendError(res, 422, 'Validation Failed');
          return;
        }
        const existing = repo.labels.get(labelName);
        if (existing !== undefined) {
          sendJson(res, 200, labelJson(existing));
          return;
        }
        const label: LabelRec = {
          id: repo.nextLabelId,
          name: labelName,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : null,
        };
        repo.nextLabelId += 1;
        repo.labels.set(labelName, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
        return;
      }
    }

    // ----- issues and comments -----
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const labelNames: string[] = [];
          if (Array.isArray(body.labels)) {
            for (const entry of body.labels) {
              const labelName = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as Record<string, unknown>).name ?? '') : '';
              if (labelName !== '') labelNames.push(labelName);
            }
          }
          for (const labelName of labelNames) {
            if (!repo.labels.has(labelName)) {
              sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
              return;
            }
          }
          const stamp = nextStamp();
          globalSeq += 1;
          const issue: IssueRec = {
            id: repo.id * 1000000 + repo.nextIssueId,
            number: repo.nextNumber,
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            labels: labelNames,
            comments: [],
            createdAt: stamp.iso,
            updatedAt: stamp.iso,
            seq: globalSeq,
          };
          repo.nextIssueId += 1;
          repo.nextNumber += 1;
          repo.issues.set(issue.number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = [...repo.issues.values()];
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          const direction = url.searchParams.get('direction') ?? 'desc';
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          sendJson(res, 200, pageSlice(list, url.searchParams).map((issue) => issueJson(repo, issue)));
          return;
        }
      }
      const issueNumber = Number(tail[1]);
      const issue = Number.isInteger(issueNumber) ? repo.issues.get(issueNumber) : undefined;
      if (tail.length === 2 && issue !== undefined) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (Array.isArray(body.labels)) {
            const names: string[] = [];
            for (const entry of body.labels) {
              const labelName = typeof entry === 'string' ? entry : '';
              if (labelName !== '' && !repo.labels.has(labelName)) {
                sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
                return;
              }
              if (labelName !== '') names.push(labelName);
            }
            issue.labels = names;
          }
          issue.updatedAt = nextStamp().iso;
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments' && issue !== undefined) {
        if (method === 'POST') {
          const stamp = nextStamp();
          const comment: CommentRec = {
            id: repo.id * 1000000 + repo.nextCommentId,
            body: typeof body.body === 'string' ? body.body : '',
            createdAt: stamp.iso,
            updatedAt: stamp.iso,
          };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(repo, issue, comment));
          return;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return;
        }
      }
      if (issue === undefined && tail.length >= 2) {
        sendError(res, 404, 'Not Found');
        return;
      }
    }

    // ----- pull requests -----
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const head = (typeof body.head === 'string' ? body.head : '').replace(/^refs\/heads\//, '');
          const base = (typeof body.base === 'string' ? body.base : '').replace(/^refs\/heads\//, '');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          if (head === '' || headSha === undefined) {
            sendError(res, 422, 'Validation Failed: head is invalid');
            return;
          }
          const baseSha = repo.refs.get(`refs/heads/${base}`) ?? ZERO_OID;
          const stamp = nextStamp();
          globalSeq += 1;
          const pull: PullRec = {
            id: repo.id * 1000000 + repo.nextPullId,
            number: repo.nextNumber,
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            state: 'open',
            headRef: head,
            baseRef: base,
            headShaAtCreate: headSha,
            baseShaAtCreate: baseSha,
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdAt: stamp.iso,
            updatedAt: stamp.iso,
            seq: globalSeq,
          };
          repo.nextPullId += 1;
          repo.nextNumber += 1;
          repo.pulls.set(pull.number, pull);
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          list.sort((a, b) => a.number - b.number);
          sendJson(res, 200, pageSlice(list, url.searchParams).map((pull) => pullJson(repo, pull)));
          return;
        }
      }
      const pullNumber = Number(tail[1]);
      const pull = Number.isInteger(pullNumber) ? repo.pulls.get(pullNumber) : undefined;
      if (tail.length >= 2 && pull === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (pull !== undefined) {
        if (tail.length === 2 && method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
          const files = pullChanges(repo, pull).map((change) => ({
            filename: change.filename,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.changes,
            sha: change.headOid ?? ZERO_OID,
          }));
          sendJson(res, 200, pageSlice(files, url.searchParams));
          return;
        }
        if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
          if (pull.merged || pull.state !== 'open') {
            sendError(res, 405, 'Pull Request is not mergeable');
            return;
          }
          const sha = mergePull(repo, pull);
          if (sha === null) {
            sendError(res, 405, 'Pull Request is not mergeable');
            return;
          }
          sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
          return;
        }
      }
    }
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and typed resolvers over the same store
// ---------------------------------------------------------------------------

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { __var: string }
  | { __enum: string };

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selection: GqlField[] | null;
  fragmentType: string | null; // set for inline fragments
  fragmentName: string | null; // set for fragment spreads
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  selection: GqlField[];
}

function tokenizeGql(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$=@!|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && /[A-Za-z0-9_.-]/.test(source[j] as string)) j += 1;
    tokens.push(source.slice(i, j));
    i = j;
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos: number;
  fragments: Map<string, GqlField[]>;

  constructor(source: string) {
    this.tokens = tokenizeGql(source);
    this.pos = 0;
    this.fragments = new Map();
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos] as string;
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`GraphQL parse: expected ${token}, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        const kind = this.next() as 'query' | 'mutation';
        if (this.peek() !== '(' && this.peek() !== '{') this.next(); // operation name
        if (this.peek() === '(') this.skipBalanced('(', ')');
        operations.push({ kind, selection: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.next(); // 'on'
        this.next(); // type name
        this.fragments.set(name, this.parseSelectionSet());
      } else if (token === '{') {
        operations.push({ kind: 'query', selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return operations;
  }

  skipBalanced(open: string, close: string): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token === undefined) return;
      if (token === open) depth += 1;
      else if (token === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          fields.push({ name: '', alias: null, args: {}, selection: this.parseSelectionSet(), fragmentType: typeName, fragmentName: null });
        } else {
          const name = this.next();
          fields.push({ name: '', alias: null, args: {}, selection: null, fragmentType: null, fragmentName: name });
        }
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, GqlValue> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.next();
      }
      if (this.peek() === '@') {
        // a directive: skip its name and any argument list
        this.next();
        this.next();
        if (this.peek() === '(') this.skipBalanced('(', ')');
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
      fields.push({ name, alias, args, selection, fragmentType: null, fragmentName: null });
    }
    this.next();
    return fields;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { __var: this.next() };
    if (token === '[') {
      const list: GqlValue[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.next();
      return list;
    }
    if (token === '{') {
      const obj: { [key: string]: GqlValue } = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.next();
      return obj;
    }
    if (token.startsWith('"')) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    if (/^-?\d+$/.test(token)) return Number(token);
    if (/^-?\d*\.\d+$/.test(token)) return Number(token);
    return { __enum: token };
  }
}

function resolveGqlValue(value: GqlValue, vars: Record<string, unknown>): unknown {
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) return value.map((item) => resolveGqlValue(item, vars));
    if ('__var' in value) return vars[(value as { __var: string }).__var];
    if ('__enum' in value) return (value as { __enum: string }).__enum;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveGqlValue(item as GqlValue, vars);
    return out;
  }
  return value;
}

// ----- typed values -----

interface GqlObj {
  __type: string;
  [key: string]: unknown;
}

function userObj(login: string): GqlObj {
  return { __type: 'User', login, id: gqlId('User', VIEWER_ID), name: 'Ada Iversen' };
}

function repoObj(repo: Repo): GqlObj {
  return { __type: 'Repository', repo };
}

function issueObj(repo: Repo, issue: IssueRec): GqlObj {
  return { __type: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: PullRec): GqlObj {
  return { __type: 'PullRequest', repo, pull };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'author', 'repository', 'createdAt', 'updatedAt', 'comments', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'url',
  ],
  Ref: ['name', 'prefix', 'target'],
  RefTarget: ['oid', 'id'],
  Label: ['name', 'color', 'description'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description', 'possibleTypes', 'inputFields'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function typeInfoObj(name: string): GqlObj | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return {
      __type: '__Type',
      name,
      kind: 'OBJECT',
      fields: (TYPE_FIELDS[name] as string[]).map((field) => ({ __type: '__Field', name: field })),
      enumValues: [],
    };
  }
  if (ENUM_TYPES[name] !== undefined) {
    return {
      __type: '__Type',
      name,
      kind: 'ENUM',
      fields: [],
      enumValues: (ENUM_TYPES[name] as string[]).map((value) => ({ __type: '__EnumValue', name: value })),
    };
  }
  return null;
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function connectionOf(
  kind: 'Issue' | 'PullRequest' | 'PullRequestFile',
  items: GqlObj[],
  numbers: number[],
  first: number | null,
  after: string | null,
): GqlObj {
  let start = 0;
  if (after !== null && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const wanted = Number(decoded.replace('cursor:', ''));
      const index = numbers.indexOf(wanted);
      if (index !== -1) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const limit = first === null ? items.length : Math.max(0, first);
  const pageItems = items.slice(start, start + limit);
  const pageNumbers = numbers.slice(start, start + limit);
  const hasNext = start + pageItems.length < items.length;
  return {
    __type: `${kind}Connection`,
    nodes: pageItems,
    edges: pageItems.map((node, index) => ({ __type: `${kind}Edge`, node, cursor: cursorOf(pageNumbers[index] as number) })),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: hasNext,
      endCursor: pageNumbers.length > 0 ? cursorOf(pageNumbers[pageNumbers.length - 1] as number) : (after ?? ''),
      hasPreviousPage: start > 0,
      startCursor: pageNumbers.length > 0 ? cursorOf(pageNumbers[0] as number) : null,
    },
    totalCount: items.length,
  };
}

function decodeGqlId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoByDbId(dbId: number): Repo | null {
  for (const repo of repos.values()) if (repo.id === dbId) return repo;
  return null;
}

interface GqlCtx {
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, GqlField[]>;
}

function gqlFieldValue(obj: GqlObj, field: string, args: Record<string, unknown>, ctx: GqlCtx): unknown {
  const type = obj.__type;
  if (type === 'Query') {
    if (field === 'viewer') return userObj(VIEWER_LOGIN);
    if (field === 'repository') {
      const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo !== null && repo.owner === VIEWER_LOGIN ? repoObj(repo) : null;
    }
    if (field === 'node') {
      const decoded = decodeGqlId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = repoByDbId(Number(decoded.parts[0]));
        return repo !== null ? repoObj(repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const repo = repoByDbId(Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo !== null && repo !== undefined && issue !== undefined ? issueObj(repo, issue) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const repo = repoByDbId(Number(decoded.parts[0]));
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        return repo !== null && repo !== undefined && pull !== undefined ? pullObj(repo, pull) : null;
      }
      return null;
    }
    if (field === '__type') return typeInfoObj(String(args.name ?? ''));
    if (field === '__schema') return { __type: '__Type', name: 'Schema', kind: 'OBJECT', fields: [], enumValues: [] };
    if (field === 'rateLimit') return null;
  }
  if (type === 'Repository') {
    const repo = obj.repo as Repo;
    switch (field) {
      case 'id': return gqlId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return userObj(repo.owner);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(headTarget(repo));
        return { __type: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: tip !== undefined ? { __type: 'RefTarget', oid: tip, id: tip } : null };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'url': return `http://forge/${repo.owner}/${repo.name}`;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue !== undefined ? issueObj(repo, issue) : null;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null) {
          list = list.filter((issue) => states.includes(issue.state.toUpperCase()));
        }
        const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
        if (orderBy !== null && orderBy.direction === 'DESC') list.sort((a, b) => b.seq - a.seq || b.number - a.number);
        else if (orderBy !== null && orderBy.direction === 'ASC') list.sort((a, b) => a.seq - b.seq || a.number - b.number);
        else list.sort((a, b) => a.number - b.number);
        return connectionOf('Issue', list.map((issue) => issueObj(repo, issue)), list.map((issue) => issue.number), typeof args.first === 'number' ? args.first : null, typeof args.after === 'string' ? args.after : null);
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull !== undefined ? pullObj(repo, pull) : null;
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()];
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null) {
          list = list.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(state) || (state === 'MERGED' && states.includes('CLOSED'));
          });
        }
        list.sort((a, b) => a.number - b.number);
        return connectionOf('PullRequest', list.map((pull) => pullObj(repo, pull)), list.map((pull) => pull.number), typeof args.first === 'number' ? args.first : null, typeof args.after === 'string' ? args.after : null);
      }
      default: break;
    }
  }
  if (type === 'Issue') {
    const repo = obj.repo as Repo;
    const issue = obj.issue as IssueRec;
    switch (field) {
      case 'id': return gqlId('Issue', repo.id, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'author': return userObj(VIEWER_LOGIN);
      case 'repository': return repoObj(repo);
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'url': return `http://forge/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'labels': {
        const nodes = issue.labels.map((name) => ({ __type: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null }));
        return {
          __type: 'LabelConnection',
          nodes,
          edges: nodes.map((node) => ({ __type: 'LabelEdge', node, cursor: cursorOf(0) })),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: '', hasPreviousPage: false, startCursor: null },
          totalCount: nodes.length,
        };
      }
      case 'comments': {
        const nodes = issue.comments.map((comment) => ({
          __type: 'IssueComment',
          id: gqlId('IssueComment', repo.id, issue.number, comment.id),
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          author: userObj(VIEWER_LOGIN),
        }));
        return {
          __type: 'IssueCommentConnection',
          nodes,
          edges: nodes.map((node) => ({ __type: 'IssueCommentEdge', node, cursor: cursorOf(0) })),
          pageInfo: { __type: 'PageInfo', hasNextPage: false, endCursor: '', hasPreviousPage: false, startCursor: null },
          totalCount: nodes.length,
        };
      }
      default: break;
    }
  }
  if (type === 'PullRequest') {
    const repo = obj.repo as Repo;
    const pull = obj.pull as PullRec;
    switch (field) {
      case 'id': return gqlId('PullRequest', repo.id, pull.number);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergeable': return pull.state !== 'open' ? 'UNKNOWN' : pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'author': return userObj(VIEWER_LOGIN);
      case 'repository': return repoObj(repo);
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'mergedAt': return pull.mergedAt;
      case 'url': return `http://forge/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const files = pullChanges(repo, pull).map((change) => ({ __type: 'PullRequestFile', path: change.filename, additions: change.additions, deletions: change.deletions }));
        return connectionOf('PullRequestFile', files, files.map((unused, index) => index + 1), typeof args.first === 'number' ? args.first : null, typeof args.after === 'string' ? args.after : null);
      }
      default: break;
    }
  }
  if (type === 'Mutation') {
    return gqlMutation(field, args, ctx);
  }
  // Plain property types (User, Ref, payloads, connections, introspection):
  const value = (obj as Record<string, unknown>)[field];
  return value === undefined ? null : value;
}

function gqlMutation(field: string, args: Record<string, unknown>, ctx: GqlCtx): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field === 'createIssue') {
    const decoded = decodeGqlId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.kind === 'Repository' ? repoByDbId(Number(decoded.parts[0])) : null;
    if (repo === null) {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return { __type: 'CreateIssuePayload', issue: null, clientMutationId: null };
    }
    const stamp = nextStamp();
    globalSeq += 1;
    const issue: IssueRec = {
      id: repo.id * 1000000 + repo.nextIssueId,
      number: repo.nextNumber,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      seq: globalSeq,
    };
    repo.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { __type: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: null };
  }
  if (field === 'closeIssue') {
    const decoded = decodeGqlId(String(input.issueId ?? ''));
    const repo = decoded !== null && decoded.kind === 'Issue' ? repoByDbId(Number(decoded.parts[0])) : null;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (repo === null || repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return { __type: 'CloseIssuePayload', issue: null, clientMutationId: null };
    }
    issue.state = 'closed';
    issue.updatedAt = nextStamp().iso;
    return { __type: 'CloseIssuePayload', issue: issueObj(repo, issue), clientMutationId: null };
  }
  if (field === 'createPullRequest') {
    const decoded = decodeGqlId(String(input.repositoryId ?? ''));
    const repo = decoded !== null && decoded.kind === 'Repository' ? repoByDbId(Number(decoded.parts[0])) : null;
    if (repo === null) {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: null };
    }
    const head = String(input.headRefName ?? '').replace(/^refs\/heads\//, '');
    const base = String(input.baseRefName ?? repo.defaultBranch).replace(/^refs\/heads\//, '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    if (headSha === undefined) {
      ctx.errors.push({ message: 'createPullRequest: head ref does not exist' });
      return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: null };
    }
    const stamp = nextStamp();
    globalSeq += 1;
    const pull: PullRec = {
      id: repo.id * 1000000 + repo.nextPullId,
      number: repo.nextNumber,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headShaAtCreate: headSha,
      baseShaAtCreate: repo.refs.get(`refs/heads/${base}`) ?? ZERO_OID,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      seq: globalSeq,
    };
    repo.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: null };
  }
  if (field === 'mergePullRequest') {
    const decoded = decodeGqlId(String(input.pullRequestId ?? ''));
    const repo = decoded !== null && decoded.kind === 'PullRequest' ? repoByDbId(Number(decoded.parts[0])) : null;
    const pull = repo?.pulls.get(Number(decoded?.parts[1]));
    if (repo === null || repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return { __type: 'MergePullRequestPayload', pullRequest: null, clientMutationId: null };
    }
    if (!pull.merged) {
      const sha = mergePull(repo, pull);
      if (sha === null) ctx.errors.push({ message: 'mergePullRequest: pull request is not mergeable' });
    }
    return { __type: 'MergePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: null };
  }
  if (field === 'addComment') {
    const decoded = decodeGqlId(String(input.subjectId ?? ''));
    const repo = decoded !== null && decoded.kind === 'Issue' ? repoByDbId(Number(decoded.parts[0])) : null;
    const issue = repo?.issues.get(Number(decoded?.parts[1]));
    if (repo === null || repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'addComment: subject not found' });
      return { __type: 'AddCommentPayload', commentEdge: null, clientMutationId: null };
    }
    const stamp = nextStamp();
    const comment: CommentRec = {
      id: repo.id * 1000000 + repo.nextCommentId,
      body: typeof input.body === 'string' ? input.body : '',
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    const node: GqlObj = { __type: 'IssueComment', id: gqlId('IssueComment', repo.id, issue.number, comment.id), body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt, author: userObj(VIEWER_LOGIN) };
    return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node, cursor: cursorOf(comment.id) }, clientMutationId: null };
  }
  ctx.errors.push({ message: `Field '${field}' doesn't exist on type 'Mutation'` });
  return null;
}

function applySelection(obj: GqlObj, selection: GqlField[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentName !== null) {
      const fragment = ctx.fragments.get(field.fragmentName);
      if (fragment !== undefined) Object.assign(out, applySelection(obj, fragment, ctx));
      continue;
    }
    if (field.fragmentType !== null) {
      if (obj.__type === field.fragmentType && field.selection !== null) Object.assign(out, applySelection(obj, field.selection, ctx));
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = obj.__type;
      continue;
    }
    const known = TYPE_FIELDS[obj.__type];
    if (known !== undefined && !known.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${obj.__type}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(field.args)) args[argName] = resolveGqlValue(argValue, ctx.vars);
    const value = gqlFieldValue(obj, field.name, args, ctx);
    out[key] = projectGql(value, field.selection, ctx);
  }
  return out;
}

function projectGql(value: unknown, selection: GqlField[] | null, ctx: GqlCtx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => projectGql(item, selection, ctx));
  if (typeof value === 'object' && selection !== null && '__type' in (value as Record<string, unknown>)) {
    return applySelection(value as GqlObj, selection, ctx);
  }
  return value;
}

function runGraphqlOperation(operation: GqlOperation, vars: Record<string, unknown>, fragments: Map<string, GqlField[]>): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: GqlCtx = { vars, errors: [], fragments };
  const root: GqlObj = operation.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = applySelection(root, operation.selection, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

function handleGraphql(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  if (!authed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const vars = (typeof entry.variables === 'object' && entry.variables !== null ? entry.variables : {}) as Record<string, unknown>;
    try {
      const parser = new GqlParser(query);
      const operations = parser.parseDocument();
      const operation = operations[0];
      if (operation === undefined) return { data: null, errors: [{ message: 'no operation found' }] };
      return runGraphqlOperation(operation, vars, parser.fragments);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => runOne(entry as Record<string, unknown>)));
    return;
  }
  sendJson(res, 200, runOne(parsed as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over streamable HTTP, tools acting on the same store
// ---------------------------------------------------------------------------

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

const MCP_TOOL_NAMES = new Set<string>(MCP_TOOLS.map((tool) => tool.name));

function mcpToolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one MCP tool; returns a tool result, or null for an unknown tool. */
function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const canonical = MCP_TOOLS.find((tool) => name.toLowerCase().endsWith(tool.name))?.name ?? name;
  if (!MCP_TOOL_NAMES.has(canonical)) return null;
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const lookup = (): Repo | null => (owner === VIEWER_LOGIN ? findRepo(owner, repoName) : null);

  if (canonical === 'create_repo') {
    const repoNameArg = typeof args.name === 'string' ? args.name : '';
    if (repoNameArg === '') return mcpToolError('create_repo requires a name');
    const existing = findRepo(VIEWER_LOGIN, repoNameArg);
    if (existing !== null) return mcpToolResult(repoJson(existing));
    const repo = createRepo(
      VIEWER_LOGIN,
      repoNameArg,
      typeof args.description === 'string' ? args.description : '',
      typeof args.private === 'boolean' ? args.private : false,
      'main',
    );
    return mcpToolResult(repoJson(repo));
  }
  if (canonical === 'get_repo') {
    const repo = lookup();
    if (repo === null) return mcpToolError(`repository ${owner}/${repoName} not found`);
    return mcpToolResult(repoJson(repo));
  }
  if (canonical === 'create_issue') {
    const repo = lookup();
    if (repo === null) return mcpToolError(`repository ${owner}/${repoName} not found`);
    const stamp = nextStamp();
    globalSeq += 1;
    const issue: IssueRec = {
      id: repo.id * 1000000 + repo.nextIssueId,
      number: repo.nextNumber,
      title: typeof args.title === 'string' ? args.title : '',
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      seq: globalSeq,
    };
    repo.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (canonical === 'list_issues') {
    const repo = lookup();
    if (repo === null) return mcpToolError(`repository ${owner}/${repoName} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issues.values()];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => a.number - b.number);
    return mcpToolResult({ issues: list.map((issue) => issueJson(repo, issue)) });
  }
  if (canonical === 'create_pull_request') {
    const repo = lookup();
    if (repo === null) return mcpToolError(`repository ${owner}/${repoName} not found`);
    const head = (typeof args.head === 'string' ? args.head : '').replace(/^refs\/heads\//, '');
    const base = (typeof args.base === 'string' ? args.base : '').replace(/^refs\/heads\//, '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    if (headSha === undefined) return mcpToolError(`head branch ${head} does not exist`);
    const stamp = nextStamp();
    globalSeq += 1;
    const pull: PullRec = {
      id: repo.id * 1000000 + repo.nextPullId,
      number: repo.nextNumber,
      title: typeof args.title === 'string' ? args.title : '',
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headShaAtCreate: headSha,
      baseShaAtCreate: repo.refs.get(`refs/heads/${base}`) ?? ZERO_OID,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      seq: globalSeq,
    };
    repo.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return mcpToolResult(pullJson(repo, pull));
  }
  // merge_pull_request
  const repo = lookup();
  if (repo === null) return mcpToolError(`repository ${owner}/${repoName} not found`);
  const pull = repo.pulls.get(Number(args.pull_number));
  if (pull === undefined) return mcpToolError(`pull request ${String(args.pull_number)} not found`);
  if (pull.merged) return mcpToolResult(pullJson(repo, pull));
  const sha = mergePull(repo, pull);
  if (sha === null) return mcpToolError('pull request is not mergeable');
  return mcpToolResult(pullJson(repo, pull));
}

function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  if (!authed(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const handleOne = (entry: Record<string, unknown>): Record<string, unknown> | null => {
    const method = typeof entry.method === 'string' ? entry.method : '';
    const id = 'id' in entry ? entry.id : undefined;
    if (id === undefined && method.startsWith('notifications/')) return null;
    const params = (typeof entry.params === 'object' && entry.params !== null ? entry.params : {}) as Record<string, unknown>;
    const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, result });
    const failWith = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (method === 'server/discover') {
      return ok({
        serverInfo: { name: 'forge', version: '1.0.0' },
        capabilities: { tools: {} },
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        protocolVersion: '2026-07-28',
      });
    }
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return ok({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge', version: '1.0.0' },
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: MCP_TOOLS });
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const canonical = MCP_TOOLS.find((tool) => toolName.toLowerCase().endsWith(tool.name))?.name;
      if (canonical === undefined) return failWith(-32602, `unknown tool: ${toolName}`);
      const schema = MCP_TOOLS.find((tool) => tool.name === canonical) as (typeof MCP_TOOLS)[number];
      for (const required of schema.inputSchema.required) {
        if (toolArgs[required] === undefined) return failWith(-32602, `missing required argument: ${required}`);
      }
      const result = runMcpTool(canonical, toolArgs);
      if (result === null) return failWith(-32602, `unknown tool: ${toolName}`);
      return ok(result);
    }
    return failWith(-32601, `method not found: ${method}`);
  };
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((entry) => handleOne(entry as Record<string, unknown>))
      .filter((entry) => entry !== null);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(replies));
    return;
  }
  const reply = handleOne(parsed as Record<string, unknown>);
  if (reply === null) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end('');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(reply));
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (path === '/api/graphql') {
    const body = await readBody(req);
    handleGraphql(req, res, body);
    return;
  }
  if (path === '/mcp') {
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    const body = await readBody(req);
    handleMcp(req, res, body);
    return;
  }
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    handleRest(req, res, url, body);
    return;
  }
  // Git smart HTTP: /{owner}/{repo}.git/...
  const segments = path.split('/').filter((part) => part !== '');
  if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
    const owner = decodeURIComponent(segments[0] as string);
    const repoName = decodeURIComponent((segments[1] as string).slice(0, -4));
    const tail = segments.slice(2).join('/');
    const repo = findRepo(owner, repoName);
    if (repo === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    if (tail === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('unknown service\n');
        return;
      }
      const protocol = req.headers['git-protocol'] ?? '';
      handleInfoRefs(repo, service, typeof protocol === 'string' && protocol.includes('version=2'), res);
      return;
    }
    if (tail === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      handleUploadPack(repo, body, res);
      return;
    }
    if (tail === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      handleReceivePack(repo, body, res);
      return;
    }
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Entry lifecycle: bind port 0, register with the env, poll /done, exit 0
// ---------------------------------------------------------------------------

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function registerWithEnv(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 3)));
  }
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // the env is not answering yet: keep polling
    }
    await sleep(400);
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await registerWithEnv(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
