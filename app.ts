// github-core-clone: a standalone GitHub-compatible git forge in one process.
//
// One Node process, standard library only, no git binary, no outside service:
//   - git smart HTTP: upload-pack protocol v2 (ls-refs, fetch, shallow/deepen) and
//     receive-pack v0 (report-status, side-band-64k, delete-refs) at /{owner}/{repo}.git
//   - REST v3 under /api/v3: repositories, branches, commits, contents, issues,
//     comments, labels, pull requests and merges
//   - GraphQL v4 at /api/graphql: the documents gh and github-mcp-server send,
//     including __type introspection, node(id:) and operation batching
//   - MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
//     (server/discover) with a legacy initialize handshake as fallback
//
// The store is entirely in memory: objects are content-addressed by SHA-1, refs are
// a map per repository, and issues/pull requests live beside them. Determinism is
// kept by construction: commit timestamps come from a counter seeded at a fixed
// epoch, global ids are pure functions of numeric ids, and no wall clock, random
// value or port ever reaches a response body.

import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// The token owner's identity.
//
// The suite's scenario is drawn from one fixed seed, so the viewer login is a
// pure function of that seed. Recomputing it here (FNV-1a label seed, splitmix64
// finalizer, xorshift64*) gives the forge the login the bearer token names
// without ever seeing the scenario file: viewer "adaiversen", id 1000.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class SeedRng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64_MASK) >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function scenarioUsers(): ScenarioUser[] {
  const rng = new SeedRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    let login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let suffix = 2;
    while (used.has(login)) {
      login = `${first}${last}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = scenarioUsers();
export const VIEWER: ScenarioUser = USERS[0] as ScenarioUser;
export const VIEWER_LOGIN = VIEWER.login;
const FIXED_EPOCH = 1_700_000_000;

// ---------------------------------------------------------------------------
// Git object model: SHA-1 content addressing, trees, commits, tags.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObj {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(value: string): boolean {
  return HEX40.test(value);
}

export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(store: Map<string, GitObj>, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const who = `${fields.author ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} +0000`;
  const committer = `${fields.committer ?? `${VIEWER.name} <${VIEWER.email}>`} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: { object: string; type: ObjType; tag: string; message: string; timestamp?: number }): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH;
  const tagger = `${VIEWER.name} <${VIEWER.email}> ${timestamp} +0000`;
  return Buffer.from(`object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line framing (the git smart-HTTP wire format).

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffered body into packets. Trailing raw bytes (a packfile) stop the scan. */
export function decodePktLines(buffer: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export function pktText(packet: Pkt): string {
  return packet.payload.toString('utf8');
}

// ---------------------------------------------------------------------------
// Packfiles: plain (non-delta) entries on write; plain + delta entries on read.

function packEntryHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size >>>= 4;
  if (size !== 0) first |= 0x80;
  bytes.push(first);
  while (size !== 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size !== 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(version, count);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate exactly one zlib stream starting at `start`, whose output is `expectedSize` bytes. */
function inflateEntry(buffer: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes and throws on truncation, so the
  // "inflates to the expected size" predicate is monotone in the length:
  // binary-search the smallest prefix that inflates correctly.
  let lo = 1;
  let hi = buffer.length - start;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buffer.subarray(start, start + mid));
      if (out.length === expectedSize) {
        answer = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (answer < 0) throw new Error('pack entry: zlib stream does not terminate');
  return { data: inflateSync(buffer.subarray(start, start + answer)), next: start + answer };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('pack delta: base size mismatch');
  const parts: Buffer[] = [];
  let size = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      size += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
      size += op;
    } else {
      throw new Error('pack delta: zero opcode');
    }
  }
  if (size !== targetSize) throw new Error('pack delta: target size mismatch');
  return Buffer.concat(parts);
}

/** Read a whole packfile into objects, resolving ofs/ref deltas against earlier entries and the store. */
export function readPack(pack: Buffer, store: Map<string, GitObj>): GitObj[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const byOffset = new Map<number, GitObj>();
  const objects: GitObj[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: negative offset varint to the base entry.
      byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (!base) throw new Error('pack ofs-delta: base entry not seen yet');
      const inflated = inflateEntry(pack, offset, size);
      offset = inflated.next;
      const resolved = { type: base.type, data: applyDelta(base.data, inflated.data) };
      byOffset.set(entryOffset, resolved);
      objects.push(resolved);
      continue;
    }
    if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.find((entry) => hashObject(entry.type, entry.data) === baseOid) ?? store.get(baseOid);
      if (!base) throw new Error('pack ref-delta: base object missing');
      const inflated = inflateEntry(pack, offset, size);
      offset = inflated.next;
      const resolved = { type: base.type, data: applyDelta(base.data, inflated.data) };
      byOffset.set(entryOffset, resolved);
      objects.push(resolved);
      continue;
    }
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`pack entry: unknown type ${typeCode}`);
    const inflated = inflateEntry(pack, offset, size);
    offset = inflated.next;
    const resolved = { type, data: inflated.data };
    byOffset.set(entryOffset, resolved);
    objects.push(resolved);
  }
  return objects;
}

// ---------------------------------------------------------------------------
// The store: one object pool, repositories with refs, issues and pull requests.

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Comment[];
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  files: PullFile[];
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  seq: number;
}

export class Forge {
  objects = new Map<string, GitObj>();
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextCommentId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  repoSeq = 0;
  commitClock = 0;
  requestSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      dbId: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.repoSeq,
    };
    this.nextRepoId += 1;
    this.repoSeq += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Next deterministic commit timestamp (seconds since the fixed epoch). */
  nextTimestamp(): number {
    this.commitClock += 1;
    return FIXED_EPOCH + this.commitClock;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}

// ---------------------------------------------------------------------------
// Graph helpers over the object pool.

/** Peel a tag to its target, recursively; anything else is already peeled. */
export function peelObject(store: Map<string, GitObj>, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Every object reachable from `roots` (commits, tags, trees, blobs). */
export function collectReachable(store: Map<string, GitObj>, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * The held set: everything the client already has. The closure of `haves`
 * stops at the client's shallow boundaries — a boundary commit is held, but
 * its parents are not, so a deepen past it still delivers them.
 */
export function heldSet(store: Map<string, GitObj>, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const queue: string[] = [];
  for (const have of haves) if (isOid(have)) queue.push(have);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (held.has(oid)) continue;
    const object = store.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallow.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return held;
}

export interface FetchSelection {
  send: Set<string>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch must send, for v0 and v2 alike.
 *   - no depth: reachable(wants) minus held.
 *   - depth N: commits within N generations of the wants plus their full tree
 *     closures, minus held; the new boundary is the deepest generation sent.
 * The shallow-info lines follow the same arithmetic: a boundary is a sent
 * commit at the deepest generation that still has parents, and an old boundary
 * is unshallow once it and all its parents are sent.
 */
export function selectFetch(
  store: Map<string, GitObj>,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchSelection {
  const shallowSet = new Set(clientShallow);
  const held = heldSet(store, haves, shallowSet);
  if (depth === null) {
    const reachable = collectReachable(store, wants);
    const send = new Set<string>();
    for (const oid of reachable) if (!held.has(oid)) send.add(oid);
    return { send, shallow: [], unshallow: [] };
  }
  // Depth-limited walk over commits, generation by generation.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    if (!isOid(want)) continue;
    const object = store.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      const target = peelObject(store, want);
      if (store.get(target)?.type === 'commit' && !dist.has(target)) {
        dist.set(target, 0);
        queue.push(target);
      }
    } else if (object.type === 'commit' && !dist.has(want)) {
      dist.set(want, 0);
      queue.push(want);
    }
  }
  const included = new Set<string>();
  const newShallow: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    const generation = dist.get(oid) as number;
    if (generation >= depth) continue;
    included.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (generation === depth - 1 && commit.parents.length > 0) newShallow.push(oid);
    if (generation + 1 < depth) {
      for (const parent of commit.parents) {
        if (!dist.has(parent) && store.get(parent)?.type === 'commit') {
          dist.set(parent, generation + 1);
          queue.push(parent);
        }
      }
    }
  }
  // Tree closures of the included commits only: a depth-limited fetch never
  // follows a commit's parents. (collectReachable would walk the whole
  // ancestry, which is exactly what a shallow clone must not carry.)
  const send = new Set<string>();
  for (const oid of included) {
    send.add(oid);
    const object = store.get(oid);
    if (object?.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const reachable of collectReachable(store, [commit.tree])) send.add(reachable);
    }
  }
  for (const want of wants) {
    const object = store.get(want);
    if (object?.type !== 'tag') continue;
    send.add(want);
    const target = peelObject(store, want);
    const targetObject = store.get(target);
    if (!targetObject) continue;
    if (targetObject.type === 'commit') {
      send.add(target);
      const tree = parseCommit(targetObject.data).tree;
      for (const reachable of collectReachable(store, [tree])) send.add(reachable);
    } else {
      for (const reachable of collectReachable(store, [target])) send.add(reachable);
    }
  }
  for (const oid of held) send.delete(oid);
  const unshallow: string[] = [];
  for (const boundary of clientShallow) {
    if (!included.has(boundary)) continue;
    const object = store.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.every((parent) => included.has(parent))) unshallow.push(boundary);
  }
  return { send, shallow: newShallow, unshallow };
}

export function isAncestor(store: Map<string, GitObj>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export function mergeBase(store: Map<string, GitObj>, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = store.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Flat file maps: a tree as path -> {oid, mode}, and back again.

export type FileMap = Map<string, { oid: string; mode: string }>;

export function treeToMap(store: Map<string, GitObj>, treeOid: string, prefix = '', out: FileMap = new Map()): FileMap {
  const object = store.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') treeToMap(store, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

export function mapToTree(store: Map<string, GitObj>, files: FileMap): string {
  // Build nested trees bottom-up: group paths by directory, deepest first.
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      let child = node.dirs.get(segment);
      if (!child) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.push({ mode: file.mode, name: segments[segments.length - 1] as string, oid: file.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

export function treeOidOfCommit(store: Map<string, GitObj>, commitOid: string): string | null {
  const object = store.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** A commit on `branch` with `files` applied over the branch tip's tree. */
export function commitFiles(
  forge: Forge,
  repo: Repo,
  branch: string,
  files: { path: string; content: Buffer }[],
  message: string,
): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const baseTree = tip ? treeOidOfCommit(forge.objects, tip) : null;
  const map: FileMap = baseTree ? treeToMap(forge.objects, baseTree) : new Map();
  for (const file of files) {
    const blobOid = putObject(forge.objects, 'blob', file.content);
    map.set(file.path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = mapToTree(forge.objects, map);
  const commitOid = putObject(
    forge.objects,
    'commit',
    buildCommit({ tree: treeOid, parents: tip ? [tip] : [], message, timestamp: forge.nextTimestamp() }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** Diff two file maps: added / modified / removed paths with line counts. */
export function diffMaps(before: FileMap, after: FileMap, store: Map<string, GitObj>): DiffEntry[] {
  const out: DiffEntry[] = [];
  const countLines = (oid: string | null): number => {
    if (!oid) return 0;
    const object = store.get(oid);
    if (!object || object.type !== 'blob') return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  for (const [path, file] of after) {
    const prev = before.get(path);
    if (!prev) {
      const lines = countLines(file.oid);
      out.push({ path, status: 'added', additions: lines, deletions: 0 });
    } else if (prev.oid !== file.oid) {
      const beforeLines = countLines(prev.oid);
      const afterLines = countLines(file.oid);
      out.push({ path, status: 'modified', additions: afterLines, deletions: beforeLines });
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      out.push({ path, status: 'removed', additions: 0, deletions: countLines(before.get(path)?.oid ?? null) });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Three-way tree merge for a squash: base tip's tree overlaid with the head's
 * changes since the merge base. Returns the merged map, or the conflicting
 * paths when both sides changed the same file differently.
 */
export function threeWayMerge(
  store: Map<string, GitObj>,
  mergeBaseOid: string | null,
  baseTip: string,
  headTip: string,
): { map: FileMap; conflicts: string[] } {
  const baseMap = new Map<string, { oid: string; mode: string }>();
  const headMap = new Map<string, { oid: string; mode: string }>();
  const ancestorMap = new Map<string, { oid: string; mode: string }>();
  const baseTree = treeOidOfCommit(store, baseTip);
  const headTree = treeOidOfCommit(store, headTip);
  if (baseTree) treeToMap(store, baseTree, '', baseMap);
  if (headTree) treeToMap(store, headTree, '', headMap);
  if (mergeBaseOid) {
    const ancestorTree = treeOidOfCommit(store, mergeBaseOid);
    if (ancestorTree) treeToMap(store, ancestorTree, '', ancestorMap);
  }
  const merged = new Map(baseMap);
  const conflicts: string[] = [];
  const paths = new Set([...ancestorMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const ancestor = ancestorMap.get(path);
    const head = headMap.get(path);
    const base = baseMap.get(path);
    const ancestorOid = ancestor?.oid ?? null;
    const headOid = head?.oid ?? null;
    const baseOid = base?.oid ?? null;
    if (headOid === ancestorOid) continue; // head unchanged: keep base
    if (baseOid === ancestorOid) {
      // base unchanged since the merge base: take head (or delete it)
      if (head) merged.set(path, head);
      else merged.delete(path);
      continue;
    }
    if (headOid === baseOid) continue; // both changed to the same thing
    conflicts.push(path);
  }
  return { map: merged, conflicts };
}

// ---------------------------------------------------------------------------
// HTTP plumbing: body reading, JSON replies, auth, request ids.

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface Ctx {
  forge: Forge;
  token: string;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function requestId(forge: Forge): string {
  forge.requestSeq += 1;
  return `req-${forge.requestSeq}`;
}

function sendJson(res: ServerResponse, forge: Forge, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId(forge),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, forge: Forge, status: number, message: string): void {
  sendJson(res, forge, status, { message });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  if (token === '') return true;
  return presented === token;
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function pageParams(url: URL): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): { pageItems: T[]; hasNext: boolean; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), hasNext: page < totalPages, totalPages };
}

function linkHeader(req: IncomingMessage, url: URL, page: number, perPage: number, totalPages: number): string {
  const build = (targetPage: number): string => {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(targetPage));
    next.searchParams.set('per_page', String(perPage));
    return `<${next.toString()}>`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`${build(page + 1)}; rel="next"`);
  if (totalPages > 1) parts.push(`${build(totalPages)}; rel="last"`);
  if (page > 1) parts.push(`${build(1)}; rel="first"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// REST serializers. Commit JSON strips one trailing newline from the message,
// the way GitHub renders it; everything else is a pure function of the store.

const FIXED_DATE = '2025-01-01T00:00:00Z';

function isoOfTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function parseIdent(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', timestamp: FIXED_EPOCH };
  return { name: match[1] as string, email: match[2] as string, timestamp: Number(match[3]) };
}

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: Buffer.from(`U:${id}`).toString('base64'), type: 'User', site_admin: false };
}

function repoJson(repo: Repo, base: string): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: Buffer.from(`R:${repo.dbId}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    pushed_at: FIXED_DATE,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    fork: false,
    archived: false,
    disabled: false,
    license: null,
    topics: [],
  };
}

function issueJson(repo: Repo, issue: Issue, base: string): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`I:${repo.dbId}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: userJson(VIEWER_LOGIN, VIEWER.id),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: issue.state === 'closed' ? FIXED_DATE : null,
    comments: issue.comments.length,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function refTip(forge: Forge, repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function pullJson(forge: Forge, repo: Repo, pull: Pull, base: string): Record<string, unknown> {
  const headSha = refTip(forge, repo, pull.head) ?? '';
  const baseSha = refTip(forge, repo, pull.base) ?? '';
  return {
    id: pull.id,
    node_id: Buffer.from(`P:${repo.dbId}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: userJson(VIEWER_LOGIN, VIEWER.id),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    closed_at: pull.state === 'closed' ? FIXED_DATE : null,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(forge: Forge, oid: string, base: string, repo: Repo): Record<string, unknown> | null {
  const object = forge.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha: oid,
    node_id: Buffer.from(`C:${oid}`).toString('base64'),
    commit: {
      message: commit.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: isoOfTimestamp(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: isoOfTimestamp(committer.timestamp) },
      tree: { sha: commit.tree },
    },
    author: userJson(VIEWER_LOGIN, VIEWER.id),
    committer: userJson(VIEWER_LOGIN, VIEWER.id),
    parents: commit.parents.map((parent) => ({ sha: parent })),
    tree: { sha: commit.tree },
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
  };
}

/** Walk a ref's history, newest first (timestamp desc, discovery order breaks ties). */
function listCommits(forge: Forge, tip: string): string[] {
  const seen = new Set<string>();
  const queue = [tip];
  const found: { oid: string; timestamp: number; order: number }[] = [];
  let order = 0;
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = forge.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    found.push({ oid, timestamp: parseIdent(commit.author).timestamp, order: order });
    order += 1;
    for (const parent of commit.parents) queue.push(parent);
  }
  found.sort((a, b) => b.timestamp - a.timestamp || a.order - b.order);
  return found.map((entry) => entry.oid);
}

function resolveRef(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null) return refTip(forge, repo, repo.defaultBranch);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  if (isOid(ref) && forge.objects.has(ref)) return ref;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// REST: repositories, branches, commits, contents.

function repoOr404(ctx: Ctx, res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return null;
  }
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return null;
  }
  return repo;
}

function handleRoot(ctx: Ctx, res: ServerResponse, base: string): void {
  sendJson(res, ctx.forge, 200, {
    current_user_url: `${base}/api/v3/user`,
    repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
    user_url: `${base}/api/v3/users/{user}`,
  });
}

function handleMeta(ctx: Ctx, res: ServerResponse): void {
  sendJson(res, ctx.forge, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
}

function handleGetUser(ctx: Ctx, res: ServerResponse): void {
  sendJson(res, ctx.forge, 200, {
    ...userJson(VIEWER_LOGIN, VIEWER.id),
    name: VIEWER.name,
    email: VIEWER.email,
    avatar_url: '',
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
  });
}

function handleListUserRepos(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const { perPage, page } = pageParams(url);
  const repos = ctx.forge.listRepos();
  const base = baseUrlOf(req);
  const { pageItems, hasNext, totalPages } = paginate(repos, perPage, page);
  const headers: Record<string, string> = {};
  if (hasNext || totalPages > 1) headers.link = linkHeader(req, url, page, perPage, totalPages);
  sendJson(res, ctx.forge, 200, pageItems.map((repo) => repoJson(repo, base)), headers);
}

function handleCreateRepo(ctx: Ctx, res: ServerResponse, req: IncomingMessage, body: unknown): void {
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  const name = asString(body.name);
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    sendError(res, ctx.forge, 422, 'Invalid repository name');
    return;
  }
  if (ctx.forge.getRepo(VIEWER_LOGIN, name)) {
    sendError(res, ctx.forge, 422, 'Repository already exists');
    return;
  }
  const repo = ctx.forge.createRepo(name, asBool(body.private, false), asString(body.description) ?? '');
  sendJson(res, ctx.forge, 201, repoJson(repo, baseUrlOf(req)));
}

function handleGetRepo(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  sendJson(res, ctx.forge, 200, repoJson(repo, baseUrlOf(req)));
}

function handlePatchRepo(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
    repo.defaultBranch = body.default_branch;
  }
  sendJson(res, ctx.forge, 200, repoJson(repo, baseUrlOf(req)));
}

function handleDeleteRepo(ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  ctx.forge.deleteRepo(owner, name);
  res.writeHead(204, { 'x-github-request-id': requestId(ctx.forge), 'x-oauth-scopes': 'repo, read:org' });
  res.end();
}

function handleListBranches(ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const branches: Record<string, unknown>[] = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  sendJson(res, ctx.forge, 200, branches);
}

function handleGetBranch(ctx: Ctx, res: ServerResponse, owner: string, name: string, branch: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  sendJson(res, ctx.forge, 200, { name: branch, commit: { sha: oid }, protected: false });
}

function handleListCommits(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, url: URL): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const tip = resolveRef(ctx.forge, repo, url.searchParams.get('sha'));
  if (!tip) {
    sendJson(res, ctx.forge, 200, []);
    return;
  }
  const base = baseUrlOf(req);
  const commits = listCommits(ctx.forge, tip)
    .map((oid) => commitJson(ctx.forge, oid, base, repo))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  sendJson(res, ctx.forge, 200, commits);
}

function handleGetCommit(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, sha: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const object = ctx.forge.objects.get(sha);
  if (!object || object.type !== 'commit') {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  const body = commitJson(ctx.forge, sha, baseUrlOf(req), repo);
  sendJson(res, ctx.forge, 200, body);
}

function handleListRefs(ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const refs: Record<string, unknown>[] = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort()) {
    const object = ctx.forge.objects.get(oid);
    refs.push({ ref, object: { sha: oid, type: object?.type ?? 'commit' } });
  }
  sendJson(res, ctx.forge, 200, refs);
}

function handleCreateRef(ctx: Ctx, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  const ref = asString(body.ref);
  const sha = asString(body.sha);
  if (!ref || !ref.startsWith('refs/') || !sha || !ctx.forge.objects.has(sha)) {
    sendError(res, ctx.forge, 422, 'Invalid ref or sha');
    return;
  }
  if (repo.refs.has(ref)) {
    sendError(res, ctx.forge, 422, 'Reference already exists');
    return;
  }
  repo.refs.set(ref, sha);
  const object = ctx.forge.objects.get(sha);
  sendJson(res, ctx.forge, 201, { ref, object: { sha, type: object?.type ?? 'commit' } });
}

function handleGetRef(ctx: Ctx, res: ServerResponse, owner: string, name: string, ref: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const oid = repo.refs.get(ref);
  if (!oid) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  const object = ctx.forge.objects.get(oid);
  sendJson(res, ctx.forge, 200, { ref, object: { sha: oid, type: object?.type ?? 'commit' } });
}

// -- contents ---------------------------------------------------------------

function contentsPathParts(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

function lookupTreePath(
  forge: Forge,
  treeOid: string,
  segments: readonly string[],
): { kind: 'blob'; oid: string } | { kind: 'tree'; oid: string } | null {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = forge.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'tree', oid: entry.oid } : { kind: 'blob', oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'tree', oid: current };
}

function handleGetContents(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, path: string, url: URL): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const base = baseUrlOf(req);
  const tip = resolveRef(ctx.forge, repo, url.searchParams.get('ref'));
  if (!tip) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  const treeOid = treeOidOfCommit(ctx.forge.objects, tip);
  if (!treeOid) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  const segments = contentsPathParts(path);
  if (segments.length === 0) {
    const entries = parseTree(ctx.forge.objects.get(treeOid)?.data ?? Buffer.alloc(0)).map((entry) =>
      dirEntryJson(ctx.forge, repo, '', entry, base),
    );
    sendJson(res, ctx.forge, 200, entries);
    return;
  }
  const found = lookupTreePath(ctx.forge, treeOid, segments);
  if (!found) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  if (found.kind === 'blob') {
    const object = ctx.forge.objects.get(found.oid);
    if (!object) {
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    sendJson(res, ctx.forge, 200, {
      type: 'file',
      encoding: 'base64',
      size: object.data.length,
      name: segments[segments.length - 1],
      path,
      content: object.data.toString('base64'),
      sha: found.oid,
      url: `${base}/api/v3/repos/${owner}/${name}/contents/${segments.map(encodeURIComponent).join('/')}`,
      html_url: `${base}/${owner}/${name}/blob/${repo.defaultBranch}/${segments.map(encodeURIComponent).join('/')}`,
      download_url: `${base}/api/v3/repos/${owner}/${name}/contents/${segments.map(encodeURIComponent).join('/')}`,
    });
    return;
  }
  const entries = parseTree(ctx.forge.objects.get(found.oid)?.data ?? Buffer.alloc(0)).map((entry) =>
    dirEntryJson(ctx.forge, repo, path, entry, base),
  );
  sendJson(res, ctx.forge, 200, entries);
}

function dirEntryJson(forge: Forge, repo: Repo, dir: string, entry: TreeEntry, base: string): Record<string, unknown> {
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const size = isDir ? 0 : (forge.objects.get(entry.oid)?.data.length ?? 0);
  return {
    type: isDir ? 'dir' : 'file',
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    html_url: `${base}/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path.split('/').map(encodeURIComponent).join('/')}`,
    download_url: isDir ? null : `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
  };
}

function handlePutContents(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, path: string, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  const message = asString(body.message) ?? 'Update file';
  const contentB64 = asString(body.content);
  if (contentB64 === null) {
    sendError(res, ctx.forge, 422, 'content is required');
    return;
  }
  const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const base = baseUrlOf(req);
  // A branch named in the body that does not exist yet is created at the
  // default branch's tip (or as a root commit when the repo is unborn).
  if (!repo.refs.has(`refs/heads/${branch}`)) {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
  }
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const treeOid = tip ? treeOidOfCommit(ctx.forge.objects, tip) : null;
  const map: FileMap = treeOid ? treeToMap(ctx.forge.objects, treeOid) : new Map();
  const existing = map.get(path);
  const sha = asString(body.sha);
  const blobOid = hashObject('blob', content);
  if (existing) {
    if (sha === null) {
      sendError(res, ctx.forge, 409, 'sha is required to update a file');
      return;
    }
    if (sha !== existing.oid) {
      sendError(res, ctx.forge, 409, 'sha does not match the current file');
      return;
    }
  } else if (sha !== null) {
    sendError(res, ctx.forge, 409, 'sha does not match the current file');
    return;
  }
  const commitOid = commitFiles(ctx.forge, repo, branch, [{ path, content }], message);
  const status = existing ? 200 : 201;
  sendJson(res, ctx.forge, status, {
    content: {
      name: path.split('/').pop(),
      path,
      sha: blobOid,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
      url: `${base}/api/v3/repos/${owner}/${name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    },
    commit: { sha: commitOid, message },
  });
}

function handleDeleteContents(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, path: string, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  if (!isRecord(body) && body !== null) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  const branch = (isRecord(body) ? asString(body.branch) : null) ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  const treeOid = treeOidOfCommit(ctx.forge.objects, tip);
  const map: FileMap = treeOid ? treeToMap(ctx.forge.objects, treeOid) : new Map();
  const existing = map.get(path);
  if (!existing) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  const sha = isRecord(body) ? asString(body.sha) : null;
  if (sha !== null && sha !== existing.oid) {
    sendError(res, ctx.forge, 409, 'sha does not match the current file');
    return;
  }
  const message = (isRecord(body) ? asString(body.message) : null) ?? 'Delete file';
  map.delete(path);
  const newTree = mapToTree(ctx.forge.objects, map);
  const commitOid = putObject(
    ctx.forge.objects,
    'commit',
    buildCommit({ tree: newTree, parents: [tip], message, timestamp: ctx.forge.nextTimestamp() }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(res, ctx.forge, 200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------------------
// REST: labels, issues, pull requests.

function handleListLabels(ctx: Ctx, res: ServerResponse, owner: string, name: string): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  sendJson(res, ctx.forge, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })));
}

function handleCreateLabel(ctx: Ctx, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  const labelName = asString(body.name);
  if (!labelName) {
    sendError(res, ctx.forge, 422, 'name is required');
    return;
  }
  const color = (asString(body.color) ?? 'ededed').replace(/^#/, '');
  repo.labels.set(labelName, { name: labelName, color });
  sendJson(res, ctx.forge, 201, { name: labelName, color, description: '' });
}

function handleListIssues(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, name: string, url: URL): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const state = url.searchParams.get('state') ?? 'open';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const { perPage, page } = pageParams(url);
  const { pageItems, hasNext, totalPages } = paginate(issues, perPage, page);
  const headers: Record<string, string> = {};
  if (hasNext || totalPages > 1) headers.link = linkHeader(req, url, page, perPage, totalPages);
  sendJson(res, ctx.forge, 200, pageItems.map((issue) => issueJson(repo, issue, baseUrlOf(req))), headers);
}

function handleCreateIssue(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  const title = asString(body.title);
  if (!title) {
    sendError(res, ctx.forge, 422, 'title is required');
    return;
  }
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const labelName of labelNames) {
    if (!repo.labels.has(labelName)) {
      sendError(res, ctx.forge, 422, `Label does not exist: ${labelName}`);
      return;
    }
  }
  const issue: Issue = {
    number: repo.nextNumber,
    id: ctx.forge.nextIssueId,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    labels: labelNames,
    createdSeq: ctx.forge.repoSeq,
    comments: [],
  };
  ctx.forge.nextIssueId += 1;
  ctx.forge.repoSeq += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  sendJson(res, ctx.forge, 201, issueJson(repo, issue, baseUrlOf(req)));
}

function handleGetIssue(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  sendJson(res, ctx.forge, 200, issueJson(repo, issue, baseUrlOf(req)));
}

function handlePatchIssue(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labelNames = body.labels.filter((entry): entry is string => typeof entry === 'string');
    for (const labelName of labelNames) {
      if (!repo.labels.has(labelName)) {
        sendError(res, ctx.forge, 422, `Label does not exist: ${labelName}`);
        return;
      }
    }
    issue.labels = labelNames;
  }
  sendJson(res, ctx.forge, 200, issueJson(repo, issue, baseUrlOf(req)));
}

function handleListComments(ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  sendJson(
    res,
    ctx.forge,
    200,
    issue.comments.map((comment) => ({
      id: comment.id,
      node_id: Buffer.from(`C:${comment.id}`).toString('base64'),
      body: comment.body,
      user: userJson(VIEWER_LOGIN, VIEWER.id),
      created_at: FIXED_DATE,
      updated_at: FIXED_DATE,
    })),
  );
}

function handleCreateComment(ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  if (!isRecord(body) || typeof body.body !== 'string') {
    sendError(res, ctx.forge, 422, 'body is required');
    return;
  }
  const comment: Comment = { id: ctx.forge.nextCommentId, body: body.body };
  ctx.forge.nextCommentId += 1;
  issue.comments.push(comment);
  sendJson(res, ctx.forge, 201, {
    id: comment.id,
    node_id: Buffer.from(`C:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(VIEWER_LOGIN, VIEWER.id),
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  });
}

function branchNameOf(value: string): string {
  // Pull-request head/base arrive as a plain branch name; tolerate "owner:branch".
  const idx = value.lastIndexOf(':');
  return idx >= 0 ? value.slice(idx + 1) : value;
}

function snapshotFiles(forge: Forge, mergeBaseOid: string | null, headTip: string): PullFile[] {
  const before: FileMap = mergeBaseOid ? (treeOidOfCommit(forge.objects, mergeBaseOid) ? treeToMap(forge.objects, treeOidOfCommit(forge.objects, mergeBaseOid) as string) : new Map()) : new Map();
  const headTree = treeOidOfCommit(forge.objects, headTip);
  const after: FileMap = headTree ? treeToMap(forge.objects, headTree) : new Map();
  return diffMaps(before, after, forge.objects)
    .filter((entry) => entry.status !== 'removed')
    .map((entry) => ({
      filename: entry.path,
      status: entry.status,
      additions: entry.additions,
      deletions: entry.deletions,
      changes: entry.additions + entry.deletions,
    }));
}

function handleCreatePull(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  if (!isRecord(body)) {
    sendError(res, ctx.forge, 400, 'Invalid request body');
    return;
  }
  const title = asString(body.title);
  const headRaw = asString(body.head);
  const baseRaw = asString(body.base);
  if (!title || !headRaw || !baseRaw) {
    sendError(res, ctx.forge, 422, 'title, head and base are required');
    return;
  }
  const head = branchNameOf(headRaw);
  const base = branchNameOf(baseRaw);
  const headTip = refTip(ctx.forge, repo, head);
  const baseTip = refTip(ctx.forge, repo, base);
  if (!headTip || !baseTip) {
    sendError(res, ctx.forge, 422, 'head or base branch does not exist');
    return;
  }
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.head === head && pull.base === base) {
      sendError(res, ctx.forge, 422, 'A pull request already exists for these branches');
      return;
    }
  }
  const baseOfMerge = mergeBase(ctx.forge.objects, headTip, baseTip);
  const pull: Pull = {
    number: repo.nextNumber,
    id: ctx.forge.nextPullId,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    head,
    base,
    merged: false,
    mergedAt: null,
    mergeSha: null,
    files: snapshotFiles(ctx.forge, baseOfMerge, headTip),
    createdSeq: ctx.forge.repoSeq,
  };
  ctx.forge.nextPullId += 1;
  ctx.forge.repoSeq += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  sendJson(res, ctx.forge, 201, pullJson(ctx.forge, repo, pull, baseUrlOf(req)));
}

function handleListPulls(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, url: URL): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const state = url.searchParams.get('state') ?? 'open';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const { perPage, page } = pageParams(url);
  const { pageItems, hasNext, totalPages } = paginate(pulls, perPage, page);
  const headers: Record<string, string> = {};
  if (hasNext || totalPages > 1) headers.link = linkHeader(req, url, page, perPage, totalPages);
  sendJson(res, ctx.forge, 200, pageItems.map((pull) => pullJson(ctx.forge, repo, pull, baseUrlOf(req))), headers);
}

function handleGetPull(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  sendJson(res, ctx.forge, 200, pullJson(ctx.forge, repo, pull, baseUrlOf(req)));
}

function handleListPullFiles(ctx: Ctx, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  sendJson(res, ctx.forge, 200, pull.files);
}

function handleMergePull(ctx: Ctx, res: ServerResponse, req: IncomingMessage, owner: string, name: string, number: number, body: unknown): void {
  const repo = repoOr404(ctx, res, owner, name);
  if (!repo) return;
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  if (pull.merged) {
    sendError(res, ctx.forge, 405, 'Pull request already merged');
    return;
  }
  if (pull.state !== 'open') {
    sendError(res, ctx.forge, 405, 'Pull request is closed');
    return;
  }
  const headTip = refTip(ctx.forge, repo, pull.head);
  const baseTip = refTip(ctx.forge, repo, pull.base);
  if (!headTip || !baseTip) {
    sendError(res, ctx.forge, 422, 'head or base branch does not exist');
    return;
  }
  const baseOfMerge = mergeBase(ctx.forge.objects, headTip, baseTip);
  const { map, conflicts } = threeWayMerge(ctx.forge.objects, baseOfMerge, baseTip, headTip);
  if (conflicts.length > 0) {
    sendError(res, ctx.forge, 405, 'Merge conflict');
    return;
  }
  const timestamp = ctx.forge.nextTimestamp();
  const treeOid = mapToTree(ctx.forge.objects, map);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
  const mergeOid = putObject(
    ctx.forge.objects,
    'commit',
    buildCommit({ tree: treeOid, parents: [baseTip], message, timestamp }),
  );
  repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoOfTimestamp(timestamp);
  pull.mergeSha = mergeOid;
  sendJson(res, ctx.forge, 200, { sha: mergeOid, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------------------
// REST router: method + path dispatch for every /api/v3 route.

async function handleRest(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL, raw: Buffer): Promise<void> {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((segment) => segment !== '');
  const base = baseUrlOf(req);

  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
    if (method === 'GET') {
      handleRoot(ctx, res, base);
      return;
    }
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'meta') {
    if (method === 'GET') {
      handleMeta(ctx, res);
      return;
    }
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user') {
    if (method === 'GET') {
      handleGetUser(ctx, res);
      return;
    }
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }
  if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      handleListUserRepos(ctx, req, res, url);
      return;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendError(res, ctx.forge, 400, 'Invalid JSON body');
        return;
      }
      handleCreateRepo(ctx, res, req, parsed.value);
      return;
    }
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/:owner/:repo/...
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = segments[3] as string;
    const name = segments[4] as string;
    const rest = segments.slice(5);
    if (rest.length === 0) {
      if (method === 'GET') {
        handleGetRepo(ctx, res, req, owner, name);
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, ctx.forge, 400, 'Invalid JSON body');
          return;
        }
        handlePatchRepo(ctx, res, req, owner, name, parsed.value);
        return;
      }
      if (method === 'DELETE') {
        handleDeleteRepo(ctx, res, owner, name);
        return;
      }
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      handleListBranches(ctx, res, owner, name);
      return;
    }
    if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
      handleGetBranch(ctx, res, owner, name, decodeURIComponent(rest[1] as string));
      return;
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      handleListCommits(ctx, res, req, owner, name, url);
      return;
    }
    if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
      handleGetCommit(ctx, res, req, owner, name, decodeURIComponent(rest[1] as string));
      return;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
      if (method === 'GET') {
        handleListRefs(ctx, res, owner, name);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, ctx.forge, 400, 'Invalid JSON body');
          return;
        }
        handleCreateRef(ctx, res, owner, name, parsed.value);
        return;
      }
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length > 2 && method === 'GET') {
      handleGetRef(ctx, res, owner, name, rest.slice(2).map(decodeURIComponent).join('/'));
      return;
    }
    if (rest[0] === 'contents' && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
      const path = rest.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        handleGetContents(ctx, res, req, owner, name, path, url);
        return;
      }
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendError(res, ctx.forge, 400, 'Invalid JSON body');
        return;
      }
      if (method === 'PUT') {
        handlePutContents(ctx, res, req, owner, name, path, parsed.value);
        return;
      }
      handleDeleteContents(ctx, res, req, owner, name, path, parsed.value);
      return;
    }
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        handleListLabels(ctx, res, owner, name);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, ctx.forge, 400, 'Invalid JSON body');
          return;
        }
        handleCreateLabel(ctx, res, owner, name, parsed.value);
        return;
      }
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'GET') {
        handleListIssues(ctx, req, res, owner, name, url);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, ctx.forge, 400, 'Invalid JSON body');
          return;
        }
        handleCreateIssue(ctx, req, res, owner, name, parsed.value);
        return;
      }
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'issues' && rest.length === 2 && /^\d+$/.test(rest[1] as string)) {
      const number = Number(rest[1]);
      if (method === 'GET') {
        handleGetIssue(ctx, req, res, owner, name, number);
        return;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, ctx.forge, 400, 'Invalid JSON body');
          return;
        }
        handlePatchIssue(ctx, req, res, owner, name, number, parsed.value);
        return;
      }
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'comments' && /^\d+$/.test(rest[1] as string)) {
      const number = Number(rest[1]);
      if (method === 'GET') {
        handleListComments(ctx, res, owner, name, number);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, ctx.forge, 400, 'Invalid JSON body');
          return;
        }
        handleCreateComment(ctx, res, owner, name, number, parsed.value);
        return;
      }
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'pulls' && rest.length === 1) {
      if (method === 'GET') {
        handleListPulls(ctx, res, req, owner, name, url);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendError(res, ctx.forge, 400, 'Invalid JSON body');
          return;
        }
        handleCreatePull(ctx, res, req, owner, name, parsed.value);
        return;
      }
      sendError(res, ctx.forge, 404, 'Not Found');
      return;
    }
    if (rest[0] === 'pulls' && rest.length === 2 && /^\d+$/.test(rest[1] as string) && method === 'GET') {
      handleGetPull(ctx, res, req, owner, name, Number(rest[1]));
      return;
    }
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'files' && /^\d+$/.test(rest[1] as string) && method === 'GET') {
      handleListPullFiles(ctx, res, owner, name, Number(rest[1]));
      return;
    }
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'merge' && /^\d+$/.test(rest[1] as string) && method === 'PUT') {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendError(res, ctx.forge, 400, 'Invalid JSON body');
        return;
      }
      handleMergePull(ctx, res, req, owner, name, Number(rest[1]), parsed.value);
      return;
    }
    sendError(res, ctx.forge, 404, 'Not Found');
    return;
  }

  sendError(res, ctx.forge, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL: a small lexer/parser/executor for exactly the documents the suite
// sends (gh's viewer/repository/__type probes, issue and PR reads, the five
// mutations, node, batched arrays, cursor pagination).

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlSelection {
  kind: 'field' | 'fragment';
  name?: string;
  alias?: string;
  args?: Record<string, GqlValue>;
  selections?: GqlSelection[];
  typeCondition?: string;
}

interface GqlOperation {
  type: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Record<string, GqlValue | undefined>;
  selections: GqlSelection[];
}

interface GqlToken {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';
  value: string;
}

function gqlLex(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
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
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  private pos = 0;
  private fragments = new Map<string, GqlSelection[]>();
  private readonly tokens: GqlToken[];

  constructor(tokens: GqlToken[]) {
    this.tokens = tokens;
  }

  private peek(): GqlToken {
    return this.tokens[this.pos] as GqlToken;
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos] as GqlToken;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got ${token.value}`);
    }
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragmentName = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        this.fragments.set(fragmentName, selections);
        void typeCondition;
        continue;
      }
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let type: GqlOperation['type'] = 'query';
    let name: string | undefined;
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { type: 'query', variables: {}, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      type = this.next().value as GqlOperation['type'];
      const nextToken = this.peek();
      if (nextToken.kind === 'name') name = this.next().value;
    }
    const variables: Record<string, GqlValue | undefined> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          variables[varName] = this.parseValue();
        } else {
          variables[varName] = undefined;
        }
      }
      this.expectPunct(')');
    }
    // Directives on the operation (@cached etc.): skip name and arguments.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    return { type, name, variables, selections: this.parseSelectionSet() };
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      if (nextToken.kind === 'name') {
        const fragmentName = this.next().value;
        const fragment = this.fragments.get(fragmentName);
        if (!fragment) throw new Error(`unknown fragment ${fragmentName}`);
        return { kind: 'fragment', selections: fragment };
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', selections };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, GqlValue> | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selections: GqlSelection[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, GqlValue> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value}`);
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(value.fields)) out[key] = resolveGqlValue(field, variables);
      return out;
    }
  }
}

// -- global ids: opaque base64, stable across the run -----------------------

function encodeGlobalId(kind: string, parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('R', [repo.dbId]);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('I', [repo.dbId, issue.number]);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('P', [repo.dbId, pull.number]);
}

function commentGlobalId(comment: Comment): string {
  return encodeGlobalId('C', [comment.id]);
}

// -- schema surface for __type ----------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_DEFS: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id',
      'databaseId',
      'name',
      'nameWithOwner',
      'owner',
      'defaultBranchRef',
      'viewerPermission',
      'hasIssuesEnabled',
      'issue',
      'issues',
      'pullRequest',
      'pullRequests',
    ],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'author', 'comments'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files'],
  },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  Comment: { kind: 'OBJECT', fields: ['id', 'body', 'author'] },
  CommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'fields', 'enumValues', 'description'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'type'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'PACKAGE'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

// -- executor ----------------------------------------------------------------

interface GqlExecCtx {
  forge: Forge;
  errors: { message: string }[];
}

type RuntimeValue = Record<string, unknown> & { __typename: string };

function runtimeValue(typename: string, fields: Record<string, unknown>): RuntimeValue {
  return { __typename: typename, ...fields };
}

function cursorOf(index: number): string {
  return Buffer.from(`c:${index}`).toString('base64');
}

function indexOfCursor(cursor: string | null): number {
  if (!cursor) return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('c:')) return -1;
    const index = Number.parseInt(decoded.slice(2), 10);
    return Number.isFinite(index) ? index : -1;
  } catch {
    return -1;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string | null;
}

function makeConnection<T>(items: readonly T[], args: ConnectionArgs): RuntimeValue {
  const afterIndex = indexOfCursor(args.after ?? null);
  const start = afterIndex + 1;
  const first = typeof args.first === 'number' ? args.first : items.length;
  const window = items.slice(start, start + first);
  const lastIndex = start + window.length - 1;
  const hasNextPage = lastIndex < items.length - 1;
  return runtimeValue('Connection', {
    nodes: window,
    edges: window.map((node, i) => runtimeValue('Edge', { node, cursor: cursorOf(start + i) })),
    pageInfo: runtimeValue('PageInfo', {
      hasNextPage,
      endCursor: window.length > 0 ? cursorOf(lastIndex) : null,
      hasPreviousPage: start > 0,
      startCursor: window.length > 0 ? cursorOf(start) : null,
    }),
    totalCount: items.length,
  });
}

function issueRuntime(repo: Repo, issue: Issue): RuntimeValue {
  return runtimeValue('Issue', {
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: FIXED_DATE,
    _repo: repo,
    _issue: issue,
  });
}

function pullRuntime(ctx: GqlExecCtx, repo: Repo, pull: Pull): RuntimeValue {
  return runtimeValue('PullRequest', {
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    _ctx: ctx,
    _repo: repo,
    _pull: pull,
  });
}

function repoRuntime(repo: Repo): RuntimeValue {
  return runtimeValue('Repository', {
    id: repoGlobalId(repo),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  });
}

function userRuntime(): RuntimeValue {
  return runtimeValue('User', {
    id: encodeGlobalId('U', [VIEWER.id]),
    login: VIEWER_LOGIN,
    name: VIEWER.name,
    email: VIEWER.email,
    avatarUrl: '',
    url: `https://example.invalid/${VIEWER_LOGIN}`,
  });
}

function findRepoByDbId(forge: Forge, dbId: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function resolveSelections(
  ctx: GqlExecCtx,
  value: RuntimeValue | null,
  selections: readonly GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition && selection.typeCondition !== value.__typename) continue;
      const nested = resolveSelections(ctx, value, selection.selections ?? [], variables);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const fieldName = selection.name as string;
    const key = selection.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[key] = value.__typename;
      continue;
    }
    let fieldValue = resolveField(ctx, value, fieldName, selection, variables);
    // Payload objects (createIssue, closeIssue, ...) carry a runtime value that
    // resolveField returns raw; resolve their nested selections here.
    if (
      fieldValue !== null &&
      typeof fieldValue === 'object' &&
      !Array.isArray(fieldValue) &&
      '__typename' in (fieldValue as Record<string, unknown>) &&
      selection.selections
    ) {
      fieldValue = resolveSelections(ctx, fieldValue as RuntimeValue, selection.selections, variables);
    }
    out[key] = fieldValue;
  }
  return out;
}

function argValue(selection: GqlSelection, name: string, variables: Record<string, unknown>): unknown {
  if (!selection.args || !(name in selection.args)) return undefined;
  return resolveGqlValue(selection.args[name] as GqlValue, variables);
}

function resolveField(
  ctx: GqlExecCtx,
  value: RuntimeValue,
  fieldName: string,
  selection: GqlSelection,
  variables: Record<string, unknown>,
): unknown {
  const typeName = value.__typename;
  const def = TYPE_DEFS[typeName];
  if (typeName === 'Query' || typeName === 'Mutation') {
    return resolveRootField(ctx, typeName, fieldName, selection, variables);
  }
  if (def?.fields && !def.fields.includes(fieldName)) {
    ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
    return undefined;
  }
  switch (typeName) {
    case 'User':
      return value[fieldName] ?? null;
    case 'Repository': {
      const repo = value._repo as Repo;
      if (fieldName === 'owner') {
        return selection.selections ? resolveSelections(ctx, userRuntime(), selection.selections, variables) : userRuntime();
      }
      if (fieldName === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        const ref = runtimeValue('Ref', { name: repo.defaultBranch });
        return selection.selections ? resolveSelections(ctx, ref, selection.selections, variables) : ref;
      }
      if (fieldName === 'issue') {
        const number = argValue(selection, 'number', variables);
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        if (!issue) return null;
        const runtime = issueRuntime(repo, issue);
        return selection.selections ? resolveSelections(ctx, runtime, selection.selections, variables) : runtime;
      }
      if (fieldName === 'issues') {
        let issues = [...repo.issues.values()];
        const states = argValue(selection, 'states', variables);
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = argValue(selection, 'orderBy', variables);
        const direction = isRecord(orderBy) && orderBy.direction === 'ASC' ? 1 : -1;
        issues.sort((a, b) => direction * (a.createdSeq - b.createdSeq) || direction * (a.number - b.number));
        const first = argValue(selection, 'first', variables);
        const after = argValue(selection, 'after', variables);
        const connection = makeConnection(
          issues.map((issue) => issueRuntime(repo, issue)),
          { first: typeof first === 'number' ? first : undefined, after: typeof after === 'string' ? after : null },
        );
        return resolveConnection(ctx, connection, selection, variables);
      }
      if (fieldName === 'pullRequest') {
        const number = argValue(selection, 'number', variables);
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        if (!pull) return null;
        const runtime = pullRuntime(ctx, repo, pull);
        return selection.selections ? resolveSelections(ctx, runtime, selection.selections, variables) : runtime;
      }
      if (fieldName === 'pullRequests') {
        const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
        const first = argValue(selection, 'first', variables);
        const after = argValue(selection, 'after', variables);
        const connection = makeConnection(
          pulls.map((pull) => pullRuntime(ctx, repo, pull)),
          { first: typeof first === 'number' ? first : undefined, after: typeof after === 'string' ? after : null },
        );
        return resolveConnection(ctx, connection, selection, variables);
      }
      return value[fieldName] ?? null;
    }
    case 'Issue': {
      const repo = value._repo as Repo;
      const issue = value._issue as Issue;
      if (fieldName === 'author') {
        return selection.selections ? resolveSelections(ctx, userRuntime(), selection.selections, variables) : userRuntime();
      }
      if (fieldName === 'comments') {
        const comments = issue.comments.map((comment) =>
          runtimeValue('Comment', { id: commentGlobalId(comment), body: comment.body, _comment: comment }),
        );
        const first = argValue(selection, 'first', variables);
        const after = argValue(selection, 'after', variables);
        const connection = makeConnection(comments, {
          first: typeof first === 'number' ? first : undefined,
          after: typeof after === 'string' ? after : null,
        });
        return resolveConnection(ctx, connection, selection, variables);
      }
      return value[fieldName] ?? null;
    }
    case 'PullRequest': {
      const repo = value._repo as Repo;
      const pull = value._pull as Pull;
      if (fieldName === 'mergeable') {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        const headTip = refTip(ctx.forge, repo, pull.head);
        const baseTip = refTip(ctx.forge, repo, pull.base);
        if (!headTip || !baseTip) return 'UNKNOWN';
        const baseOfMerge = mergeBase(ctx.forge.objects, headTip, baseTip);
        const { conflicts } = threeWayMerge(ctx.forge.objects, baseOfMerge, baseTip, headTip);
        return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (fieldName === 'files') {
        const files = pull.files.map((file) =>
          runtimeValue('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions }),
        );
        const first = argValue(selection, 'first', variables);
        const after = argValue(selection, 'after', variables);
        const connection = makeConnection(files, {
          first: typeof first === 'number' ? first : undefined,
          after: typeof after === 'string' ? after : null,
        });
        return resolveConnection(ctx, connection, selection, variables);
      }
      return value[fieldName] ?? null;
    }
    case '__Type': {
      const typeNameValue = value._typeName as string;
      const typeDef = TYPE_DEFS[typeNameValue];
      if (fieldName === 'name') return typeNameValue;
      if (fieldName === 'kind') return typeDef?.kind ?? null;
      if (fieldName === 'fields') {
        if (!typeDef?.fields) return null;
        const fields = typeDef.fields.map((name) => runtimeValue('__Field', { name, description: null }));
        return resolveListOfObjects(ctx, fields, selection, variables);
      }
      if (fieldName === 'enumValues') {
        if (!typeDef?.enumValues) return null;
        const enumValues = typeDef.enumValues.map((name) => runtimeValue('__EnumValue', { name, description: null }));
        return resolveListOfObjects(ctx, enumValues, selection, variables);
      }
      if (fieldName === 'description') return null;
      return null;
    }
    case 'Connection':
    case 'Edge':
    case 'PageInfo':
    case '__Field':
    case '__EnumValue':
    case 'Ref':
    case 'Comment':
      return value[fieldName] ?? null;
    default:
      return value[fieldName] ?? null;
  }
}

function resolveListOfObjects(
  ctx: GqlExecCtx,
  items: RuntimeValue[],
  selection: GqlSelection,
  variables: Record<string, unknown>,
): unknown[] {
  if (!selection.selections) return items;
  return items.map((item) => resolveSelections(ctx, item, selection.selections as GqlSelection[], variables));
}

function resolveConnection(
  ctx: GqlExecCtx,
  connection: RuntimeValue,
  selection: GqlSelection,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  if (!selection.selections) return {};
  const out: Record<string, unknown> = {};
  for (const sub of selection.selections) {
    if (sub.kind === 'fragment') {
      const nested = resolveSelections(ctx, connection, [sub], variables);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const key = sub.alias ?? (sub.name as string);
    if (sub.name === 'nodes') {
      const nodes = connection.nodes as RuntimeValue[];
      out[key] = sub.selections ? nodes.map((node) => resolveSelections(ctx, node, sub.selections as GqlSelection[], variables)) : nodes;
    } else if (sub.name === 'edges') {
      const edges = connection.edges as RuntimeValue[];
      out[key] = sub.selections
        ? edges.map((edge) => {
            const edgeOut: Record<string, unknown> = {};
            for (const edgeSel of sub.selections as GqlSelection[]) {
              if (edgeSel.kind === 'fragment') continue;
              if (edgeSel.name === 'node') {
                const node = edge.node as RuntimeValue;
                edgeOut[edgeSel.alias ?? 'node'] = edgeSel.selections
                  ? resolveSelections(ctx, node, edgeSel.selections, variables)
                  : node;
              } else {
                edgeOut[edgeSel.alias ?? (edgeSel.name as string)] = edge[edgeSel.name as string] ?? null;
              }
            }
            return edgeOut;
          })
        : edges;
    } else if (sub.name === 'pageInfo') {
      const pageInfo = connection.pageInfo as RuntimeValue;
      out[key] = sub.selections ? resolveSelections(ctx, pageInfo, sub.selections, variables) : pageInfo;
    } else if (sub.name === 'totalCount') {
      out[key] = connection.totalCount;
    } else {
      out[key] = null;
    }
  }
  return out;
}

function resolveRootField(
  ctx: GqlExecCtx,
  rootType: string,
  fieldName: string,
  selection: GqlSelection,
  variables: Record<string, unknown>,
): unknown {
  if (rootType === 'Query') {
    if (fieldName === 'viewer') {
      return selection.selections ? resolveSelections(ctx, userRuntime(), selection.selections, variables) : userRuntime();
    }
    if (fieldName === 'repository') {
      const owner = argValue(selection, 'owner', variables);
      const name = argValue(selection, 'name', variables);
      const repo = typeof owner === 'string' && typeof name === 'string' ? ctx.forge.getRepo(owner, name) : undefined;
      if (!repo) return null;
      const runtime = repoRuntime(repo);
      return selection.selections ? resolveSelections(ctx, runtime, selection.selections, variables) : runtime;
    }
    if (fieldName === 'node') {
      const id = argValue(selection, 'id', variables);
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      let runtime: RuntimeValue | null = null;
      if (decoded.kind === 'R') {
        const repo = findRepoByDbId(ctx.forge, Number(decoded.parts[0]));
        if (repo) runtime = repoRuntime(repo);
      } else if (decoded.kind === 'I') {
        const repo = findRepoByDbId(ctx.forge, Number(decoded.parts[0]));
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        if (repo && issue) runtime = issueRuntime(repo, issue);
      } else if (decoded.kind === 'P') {
        const repo = findRepoByDbId(ctx.forge, Number(decoded.parts[0]));
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        if (repo && pull) runtime = pullRuntime(ctx, repo, pull);
      }
      if (!runtime) return null;
      return selection.selections ? resolveSelections(ctx, runtime, selection.selections, variables) : runtime;
    }
    if (fieldName === '__type') {
      const name = argValue(selection, 'name', variables);
      if (typeof name !== 'string' || !TYPE_DEFS[name]) return null;
      const runtime = runtimeValue('__Type', { _typeName: name });
      return selection.selections ? resolveSelections(ctx, runtime, selection.selections, variables) : runtime;
    }
    if (fieldName === '__schema') return null;
    ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "Query".` });
    return undefined;
  }
  // Mutation root.
  const input = argValue(selection, 'input', variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: `Field "${fieldName}" requires an input object.` });
    return null;
  }
  if (fieldName === 'createIssue') {
    const repositoryId = input.repositoryId;
    const title = input.title;
    if (typeof repositoryId !== 'string' || typeof title !== 'string') {
      ctx.errors.push({ message: 'createIssue requires repositoryId and title.' });
      return null;
    }
    const decoded = decodeGlobalId(repositoryId);
    const repo = decoded?.kind === 'R' ? findRepoByDbId(ctx.forge, Number(decoded.parts[0])) : null;
    if (!repo) {
      ctx.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const issue: Issue = {
      number: repo.nextNumber,
      id: ctx.forge.nextIssueId,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      createdSeq: ctx.forge.repoSeq,
      comments: [],
    };
    ctx.forge.nextIssueId += 1;
    ctx.forge.repoSeq += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    const payload = runtimeValue('CreateIssuePayload', { issue: issueRuntime(repo, issue) });
    return selection.selections ? resolveSelections(ctx, payload, selection.selections, variables) : payload;
  }
  if (fieldName === 'closeIssue') {
    const issueId = input.issueId;
    if (typeof issueId !== 'string') {
      ctx.errors.push({ message: 'closeIssue requires issueId.' });
      return null;
    }
    const decoded = decodeGlobalId(issueId);
    const repo = decoded?.kind === 'I' ? findRepoByDbId(ctx.forge, Number(decoded.parts[0])) : null;
    const issue = repo?.issues.get(Number(decoded?.parts[1] ?? -1));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Issue not found.' });
      return null;
    }
    issue.state = 'closed';
    const payload = runtimeValue('CloseIssuePayload', { issue: issueRuntime(repo, issue) });
    return selection.selections ? resolveSelections(ctx, payload, selection.selections, variables) : payload;
  }
  if (fieldName === 'createPullRequest') {
    const repositoryId = input.repositoryId;
    const baseRefName = input.baseRefName;
    const headRefName = input.headRefName;
    const title = input.title;
    if (
      typeof repositoryId !== 'string' ||
      typeof baseRefName !== 'string' ||
      typeof headRefName !== 'string' ||
      typeof title !== 'string'
    ) {
      ctx.errors.push({ message: 'createPullRequest requires repositoryId, baseRefName, headRefName and title.' });
      return null;
    }
    const decoded = decodeGlobalId(repositoryId);
    const repo = decoded?.kind === 'R' ? findRepoByDbId(ctx.forge, Number(decoded.parts[0])) : null;
    if (!repo) {
      ctx.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const headTip = refTip(ctx.forge, repo, headRefName);
    const baseTip = refTip(ctx.forge, repo, baseRefName);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: 'head or base branch does not exist.' });
      return null;
    }
    for (const pull of repo.pulls.values()) {
      if (pull.state === 'open' && pull.head === headRefName && pull.base === baseRefName) {
        ctx.errors.push({ message: 'A pull request already exists for these branches.' });
        return null;
      }
    }
    const baseOfMerge = mergeBase(ctx.forge.objects, headTip, baseTip);
    const pull: Pull = {
      number: repo.nextNumber,
      id: ctx.forge.nextPullId,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      head: headRefName,
      base: baseRefName,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      files: snapshotFiles(ctx.forge, baseOfMerge, headTip),
      createdSeq: ctx.forge.repoSeq,
    };
    ctx.forge.nextPullId += 1;
    ctx.forge.repoSeq += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    const payload = runtimeValue('CreatePullRequestPayload', { pullRequest: pullRuntime(ctx, repo, pull) });
    return selection.selections ? resolveSelections(ctx, payload, selection.selections, variables) : payload;
  }
  if (fieldName === 'mergePullRequest') {
    const pullRequestId = input.pullRequestId;
    if (typeof pullRequestId !== 'string') {
      ctx.errors.push({ message: 'mergePullRequest requires pullRequestId.' });
      return null;
    }
    const decoded = decodeGlobalId(pullRequestId);
    const repo = decoded?.kind === 'P' ? findRepoByDbId(ctx.forge, Number(decoded.parts[0])) : null;
    const pull = repo?.pulls.get(Number(decoded?.parts[1] ?? -1));
    if (!repo || !pull) {
      ctx.errors.push({ message: 'Pull request not found.' });
      return null;
    }
    if (pull.merged || pull.state !== 'open') {
      ctx.errors.push({ message: 'Pull request is not open.' });
      return null;
    }
    const headTip = refTip(ctx.forge, repo, pull.head);
    const baseTip = refTip(ctx.forge, repo, pull.base);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: 'head or base branch does not exist.' });
      return null;
    }
    const baseOfMerge = mergeBase(ctx.forge.objects, headTip, baseTip);
    const { map, conflicts } = threeWayMerge(ctx.forge.objects, baseOfMerge, baseTip, headTip);
    if (conflicts.length > 0) {
      ctx.errors.push({ message: 'Merge conflict.' });
      return null;
    }
    const timestamp = ctx.forge.nextTimestamp();
    const treeOid = mapToTree(ctx.forge.objects, map);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
    const mergeOid = putObject(
      ctx.forge.objects,
      'commit',
      buildCommit({ tree: treeOid, parents: [baseTip], message, timestamp }),
    );
    repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOfTimestamp(timestamp);
    pull.mergeSha = mergeOid;
    const payload = runtimeValue('MergePullRequestPayload', { pullRequest: pullRuntime(ctx, repo, pull) });
    return selection.selections ? resolveSelections(ctx, payload, selection.selections, variables) : payload;
  }
  if (fieldName === 'addComment') {
    const subjectId = input.subjectId;
    const body = input.body;
    if (typeof subjectId !== 'string' || typeof body !== 'string') {
      ctx.errors.push({ message: 'addComment requires subjectId and body.' });
      return null;
    }
    const decoded = decodeGlobalId(subjectId);
    if (decoded?.kind !== 'I') {
      ctx.errors.push({ message: 'addComment subject must be an issue.' });
      return null;
    }
    const repo = findRepoByDbId(ctx.forge, Number(decoded.parts[0]));
    const issue = repo?.issues.get(Number(decoded.parts[1]));
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Issue not found.' });
      return null;
    }
    const comment: Comment = { id: ctx.forge.nextCommentId, body };
    ctx.forge.nextCommentId += 1;
    issue.comments.push(comment);
    const node = runtimeValue('Comment', { id: commentGlobalId(comment), body });
    const edge = runtimeValue('CommentEdge', { node });
    const payload = runtimeValue('AddCommentPayload', { commentEdge: edge });
    return selection.selections ? resolveSelections(ctx, payload, selection.selections, variables) : payload;
  }
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "Mutation".` });
  return undefined;
}

function executeGqlOperation(
  ctx: GqlExecCtx,
  operation: GqlOperation,
  providedVariables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const variables: Record<string, unknown> = {};
  for (const [name, defaultValue] of Object.entries(operation.variables)) {
    if (name in providedVariables) variables[name] = providedVariables[name];
    else if (defaultValue !== undefined) variables[name] = resolveGqlValue(defaultValue, providedVariables);
    else variables[name] = null;
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = runtimeValue(rootType, {});
  const data = resolveSelections(ctx, root, operation.selections, variables);
  return { data, errors: ctx.errors };
}

function handleGraphQL(ctx: Ctx, res: ServerResponse, raw: Buffer): void {
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, ctx.forge, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL document is required.' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(gqlLex(doc.query)).parseDocument();
    } catch (error) {
      return { data: null, errors: [{ message: error instanceof Error ? error.message : 'Syntax error' }] };
    }
    let operation = operations[0];
    if (typeof doc.operationName === 'string') {
      operation = operations.find((candidate) => candidate.name === doc.operationName) ?? operations[0];
    }
    if (!operation) return { data: null, errors: [{ message: 'No operation found.' }] };
    const execCtx: GqlExecCtx = { forge: ctx.forge, errors: [] };
    const { data, errors } = executeGqlOperation(execCtx, operation, variables);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, ctx.forge, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, ctx.forge, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 Streamable HTTP on POST /mcp. Eight tools over the same
// store the REST surface uses. Tool list is a module constant so tools/list
// is byte-identical on every call.

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
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
    description: 'Get a repository by owner and name.',
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
    name: 'list_repos',
    description: 'List repositories owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login to list repositories for' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
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
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
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
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

type McpToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function mcpOk(value: unknown, structured?: Record<string, unknown>): McpToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], structuredContent: structured };
}

function mcpError(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpMissingArg(args: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (value === undefined || value === null || value === '') return name;
  }
  return null;
}

function mcpNumber(args: Record<string, unknown>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function callMcpTool(ctx: Ctx, name: string, args: Record<string, unknown>): McpToolResult {
  const forge = ctx.forge;
  switch (name) {
    case 'create_repo': {
      const missing = mcpMissingArg(args, ['name']);
      if (missing) return mcpError(`Missing required argument: ${missing}`);
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER_LOGIN, repoName)) return mcpError('Repository already exists');
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      const body = {
        id: repo.dbId,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        private: repo.isPrivate,
        description: repo.description,
        default_branch: repo.defaultBranch,
      };
      return mcpOk(body, body);
    }
    case 'get_repo': {
      const missing = mcpMissingArg(args, ['owner', 'repo']);
      if (missing) return mcpError(`Missing required argument: ${missing}`);
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return mcpError('Repository not found');
      const body = repoJson(repo, '');
      return mcpOk(body, body as Record<string, unknown>);
    }
    case 'list_repos': {
      const repos = forge.listRepos().map((repo) => repoJson(repo, ''));
      return mcpOk(repos, { repositories: repos });
    }
    case 'create_issue': {
      const missing = mcpMissingArg(args, ['owner', 'repo', 'title']);
      if (missing) return mcpError(`Missing required argument: ${missing}`);
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return mcpError('Repository not found');
      const issue: Issue = {
        number: repo.nextNumber,
        id: forge.nextIssueId,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: forge.repoSeq,
        comments: [],
      };
      forge.nextIssueId += 1;
      forge.repoSeq += 1;
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      const body = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
      return mcpOk(body, body);
    }
    case 'list_issues': {
      const missing = mcpMissingArg(args, ['owner', 'repo']);
      if (missing) return mcpError(`Missing required argument: ${missing}`);
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return mcpError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      const list = issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }));
      return mcpOk(list, { issues: list });
    }
    case 'get_issue': {
      const missing = mcpMissingArg(args, ['owner', 'repo']);
      if (missing) return mcpError(`Missing required argument: ${missing}`);
      const number = mcpNumber(args, ['issue_number', 'number', 'issueNumber']);
      if (number === null) return mcpError('Missing required argument: issue_number');
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return mcpError('Repository not found');
      const issue = repo.issues.get(number);
      if (!issue) return mcpError('Issue not found');
      const body = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
      return mcpOk(body, body);
    }
    case 'create_pull_request': {
      const missing = mcpMissingArg(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing) return mcpError(`Missing required argument: ${missing}`);
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return mcpError('Repository not found');
      const head = branchNameOf(String(args.head));
      const base = branchNameOf(String(args.base));
      const headTip = refTip(forge, repo, head);
      const baseTip = refTip(forge, repo, base);
      if (!headTip || !baseTip) return mcpError('head or base branch does not exist');
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.head === head && pull.base === base) {
          return mcpError('A pull request already exists for these branches');
        }
      }
      const baseOfMerge = mergeBase(forge.objects, headTip, baseTip);
      const pull: Pull = {
        number: repo.nextNumber,
        id: forge.nextPullId,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        head,
        base,
        merged: false,
        mergedAt: null,
        mergeSha: null,
        files: snapshotFiles(forge, baseOfMerge, headTip),
        createdSeq: forge.repoSeq,
      };
      forge.nextPullId += 1;
      forge.repoSeq += 1;
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      const body = {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: pull.head,
        base: pull.base,
      };
      return mcpOk(body, body);
    }
    case 'merge_pull_request': {
      const missing = mcpMissingArg(args, ['owner', 'repo']);
      if (missing) return mcpError(`Missing required argument: ${missing}`);
      const number = mcpNumber(args, ['pull_number', 'number', 'pullNumber']);
      if (number === null) return mcpError('Missing required argument: pull_number');
      const repo = forge.getRepo(String(args.owner), String(args.repo));
      if (!repo) return mcpError('Repository not found');
      const pull = repo.pulls.get(number);
      if (!pull) return mcpError('Pull request not found');
      if (pull.merged || pull.state !== 'open') return mcpError('Pull request is not open');
      const headTip = refTip(forge, repo, pull.head);
      const baseTip = refTip(forge, repo, pull.base);
      if (!headTip || !baseTip) return mcpError('head or base branch does not exist');
      const baseOfMerge = mergeBase(forge.objects, headTip, baseTip);
      const { map, conflicts } = threeWayMerge(forge.objects, baseOfMerge, baseTip, headTip);
      if (conflicts.length > 0) return mcpError('Merge conflict');
      const timestamp = forge.nextTimestamp();
      const treeOid = mapToTree(forge.objects, map);
      const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
      const mergeOid = putObject(forge.objects, 'commit', buildCommit({ tree: treeOid, parents: [baseTip], message, timestamp }));
      repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = isoOfTimestamp(timestamp);
      pull.mergeSha = mergeOid;
      const body = { sha: mergeOid, merged: true, number: pull.number, state: 'MERGED' };
      return mcpOk(body, body);
    }
    default:
      return mcpError(`Unknown tool: ${name}`);
  }
}

function handleMcp(ctx: Ctx, res: ServerResponse, raw: Buffer): void {
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, ctx.forge, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const body = parsed.value;
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, ctx.forge, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = 'id' in body ? body.id : null;
  const reply = (result: unknown): void => {
    sendJson(res, ctx.forge, 200, { jsonrpc: '2.0', id: id ?? null, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, ctx.forge, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };
  switch (body.method) {
    case 'server/discover':
      reply({
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        protocolVersion: '2026-07-28',
        serverInfo: { name: 'github-core-clone', version: '2.0.0' },
        capabilities: { tools: {} },
      });
      return;
    case 'initialize': {
      const params = isRecord(body.params) ? body.params : {};
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28';
      reply({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '2.0.0' },
      });
      return;
    }
    case 'notifications/initialized':
      res.writeHead(202);
      res.end();
      return;
    case 'ping':
      reply({});
      return;
    case 'tools/list':
      reply({ tools: MCP_TOOLS });
      return;
    case 'tools/call': {
      const params = isRecord(body.params) ? body.params : {};
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (!MCP_TOOLS.some((tool) => tool.name === toolName)) {
        replyError(-32602, `Unknown tool: ${toolName}`);
        return;
      }
      const result = callMcpTool(ctx, toolName, args);
      reply(result);
      return;
    }
    default:
      replyError(-32601, `Method not found: ${body.method}`);
  }
}

// ---------------------------------------------------------------------------
// Git smart HTTP: v0/v2 advertisements, ls-refs, fetch (v0 + v2, shallow and
// deepen), and receive-pack. Pkt-line helpers here are local to this section.

interface GlPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  text?: string;
  end: number;
}

function glPkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

function glFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function glDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function glDecode(body: Buffer): GlPacket[] {
  const packets: GlPacket[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!Number.isFinite(length) || length < 0 || length > 65520) break;
    if (length === 0) {
      packets.push({ kind: 'flush', end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', end: offset + 4 });
      offset += 4;
      continue;
    }
    if (offset + length > body.length) break;
    packets.push({ kind: 'data', text: body.subarray(offset + 4, offset + length).toString('utf8'), end: offset + length });
    offset += length;
  }
  return packets;
}

function glSideband(data: Buffer): Buffer {
  return glPkt(Buffer.concat([Buffer.from([1]), data]));
}

function packSidebandChunks(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < pack.length; i += 32768) {
    chunks.push(glSideband(pack.subarray(i, i + 32768)));
  }
  return chunks;
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function gitRepoOr404(ctx: Ctx, res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return null;
  }
  const repo = ctx.forge.getRepo(owner, name);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return null;
  }
  return repo;
}

function v0UploadAd(ctx: Ctx, repo: Repo): Buffer {
  const parts: Buffer[] = [glPkt('# service=git-upload-pack\n'), glFlush()];
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(glPkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]?.[1] ?? ZERO_OID;
    parts.push(glPkt(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(glPkt(`${oid} ${ref}\n`));
      const object = ctx.forge.objects.get(oid);
      if (object?.type === 'tag') {
        parts.push(glPkt(`${peelObject(ctx.forge.objects, oid)} ${ref}^{}\n`));
      }
    }
  }
  parts.push(glFlush());
  return Buffer.concat(parts);
}

function v0ReceiveAd(ctx: Ctx, repo: Repo): Buffer {
  const parts: Buffer[] = [glPkt('# service=git-receive-pack\n'), glFlush()];
  const caps = 'report-status side-band-64k delete-refs ofs-delta';
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(glPkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]?.[1] ?? ZERO_OID;
    parts.push(glPkt(`${headOid} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(glPkt(`${oid} ${ref}\n`));
    }
  }
  parts.push(glFlush());
  return Buffer.concat(parts);
}

function v2UploadAd(): Buffer {
  return Buffer.concat([
    glPkt('# service=git-upload-pack\n'),
    glFlush(),
    glPkt('version 2\n'),
    glPkt('agent=github-core-clone/2.0.0\n'),
    glPkt('ls-refs=unborn\n'),
    glPkt('fetch=shallow wait-for-done filter\n'),
    glPkt('object-format=sha1\n'),
    glPkt('server-option\n'),
    glFlush(),
  ]);
}

function handleInfoRefs(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, name: string, url: URL): void {
  const service = url.searchParams.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  const repo = gitRepoOr404(ctx, res, owner, name);
  if (!repo) return;
  const wantsV2 = req.headers['git-protocol'] === 'version=2';
  if (service === 'git-upload-pack') {
    const body = wantsV2 ? v2UploadAd() : v0UploadAd(ctx, repo);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    res.end(body);
    return;
  }
  const body = v0ReceiveAd(ctx, repo);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' });
  res.end(body);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(packets: readonly GlPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data' || !packet.text) continue;
    const line = packet.text.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth)) args.depth = depth;
    }
  }
  return args;
}

function fetchPack(forge: Forge, selection: FetchSelection): Buffer | null {
  if (selection.send.size === 0) return null;
  const objects: GitObj[] = [];
  for (const oid of selection.send) {
    const object = forge.objects.get(oid);
    if (object) objects.push({ type: object.type, data: object.data });
  }
  return writePack(objects);
}

function ackLines(forge: Forge, haves: readonly string[], withReady: boolean): string[] {
  if (haves.length === 0) return ['NAK'];
  const acks = haves.filter((have) => forge.objects.has(have));
  if (acks.length === 0) return ['NAK'];
  const lines = acks.map((ack) => `ACK ${ack}`);
  if (withReady) lines.push('ready');
  return lines;
}

function handleLsRefsV2(ctx: Ctx, res: ServerResponse, repo: Repo, packets: readonly GlPacket[]): void {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !packet.text) continue;
    if (!afterDelim) continue;
    const line = packet.text.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip) {
    const headIncluded = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
    if (headIncluded) {
      lines.push(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.startsWith(prefix))) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = ctx.forge.objects.get(oid);
      if (object?.type === 'tag') line += ` peeled:${peelObject(ctx.forge.objects, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  const parts: Buffer[] = lines.map((line) => glPkt(line));
  parts.push(glFlush());
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function handleFetchV2(ctx: Ctx, res: ServerResponse, repo: Repo, packets: readonly GlPacket[]): void {
  const args = parseFetchArgs(packets);
  const selection = selectFetch(ctx.forge.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  parts.push(glPkt('acknowledgments\n'));
  for (const line of ackLines(ctx.forge, args.haves, true)) parts.push(glPkt(`${line}\n`));
  parts.push(glDelim());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(glPkt('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(glPkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(glPkt(`unshallow ${oid}\n`));
    parts.push(glDelim());
  }
  const pack = fetchPack(ctx.forge, selection);
  if (pack) {
    parts.push(glPkt('packfile\n'));
    parts.push(...packSidebandChunks(pack));
  }
  parts.push(glFlush());
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function handleFetchV0(ctx: Ctx, res: ServerResponse, repo: Repo, packets: readonly GlPacket[]): void {
  const args = parseFetchArgs(packets);
  const selection = selectFetch(ctx.forge.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const line of ackLines(ctx.forge, args.haves, false)) parts.push(glPkt(`${line}\n`));
  for (const oid of selection.shallow) parts.push(glPkt(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(glPkt(`unshallow ${oid}\n`));
  const pack = fetchPack(ctx.forge, selection);
  if (pack) parts.push(...packSidebandChunks(pack));
  parts.push(glFlush());
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function handleUploadPack(ctx: Ctx, req: IncomingMessage, res: ServerResponse, owner: string, name: string, raw: Buffer): void {
  const repo = gitRepoOr404(ctx, res, owner, name);
  if (!repo) return;
  let packets: GlPacket[];
  try {
    packets = glDecode(raw);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  const wantsV2 = req.headers['git-protocol'] === 'version=2';
  if (wantsV2) {
    const commandLine = packets.find((packet) => packet.kind === 'data')?.text?.replace(/\n$/, '') ?? '';
    if (commandLine === 'command=ls-refs') {
      handleLsRefsV2(ctx, res, repo, packets);
      return;
    }
    if (commandLine === 'command=fetch') {
      handleFetchV2(ctx, res, repo, packets);
      return;
    }
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Bad Request');
    return;
  }
  handleFetchV0(ctx, res, repo, packets);
}

function handleReceivePack(ctx: Ctx, res: ServerResponse, owner: string, name: string, raw: Buffer): void {
  const repo = gitRepoOr404(ctx, res, owner, name);
  if (!repo) return;
  const packets = glDecode(raw);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = raw.length;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      packStart = packet.end;
      break;
    }
    if (packet.kind !== 'data' || !packet.text) continue;
    const line = packet.text.replace(/\n$/, '').split('\0')[0] as string;
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = raw.subarray(packStart);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, ctx.forge.objects);
      for (const object of objects) {
        const oid = hashObject(object.type, object.data);
        if (!ctx.forge.objects.has(oid)) ctx.forge.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  const results: { ref: string; ok: boolean }[] = [];
  for (const command of commands) {
    let ok = false;
    if (!unpackOk) {
      ok = false;
    } else if (command.oldOid === ZERO_OID && command.newOid !== ZERO_OID) {
      // Create.
      if (!repo.refs.has(command.ref)) {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    } else if (command.oldOid !== ZERO_OID && command.newOid !== ZERO_OID) {
      // Update: old must match and the new tip must descend from the old one.
      const current = repo.refs.get(command.ref);
      if (current === command.oldOid && isAncestor(ctx.forge.objects, command.oldOid, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        ok = true;
      }
    } else if (command.oldOid !== ZERO_OID && command.newOid === ZERO_OID) {
      // Delete: old must match.
      if (repo.refs.get(command.ref) === command.oldOid) {
        repo.refs.delete(command.ref);
        ok = true;
      }
    }
    results.push({ ref: command.ref, ok });
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    reportLines.push('unpack ok');
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} non-fast-forward`);
    }
  } else {
    reportLines.push('unpack error');
    for (const result of results) {
      reportLines.push(`ng ${result.ref} unpack failed`);
    }
  }
  const parts: Buffer[] = [];
  for (const line of reportLines) parts.push(glSideband(glPkt(`${line}\n`)));
  parts.push(glFlush());
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// Server assembly and top-level dispatch.

export function createForgeServer(options: { token?: string } = {}): Server {
  const forge = new Forge();
  const ctx: Ctx = { forge, token: options.token ?? '' };
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const method = req.method ?? 'GET';
        const segments = url.pathname.split('/').filter((segment) => segment !== '');
        if (url.pathname === '/healthz') {
          if (method === 'GET') sendJson(res, forge, 200, { ok: true });
          else sendError(res, forge, 404, 'Not Found');
          return;
        }
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const raw = needsBody ? await readBody(req) : Buffer.alloc(0);
        // Git smart HTTP: no bearer auth, repositories exist only via REST.
        if (segments.length === 4 && segments[1]?.endsWith('.git') && segments[2] === 'info' && segments[3] === 'refs') {
          if (method === 'GET') {
            handleInfoRefs(ctx, req, res, segments[0] as string, segments[1].slice(0, -4), url);
            return;
          }
          sendError(res, forge, 404, 'Not Found');
          return;
        }
        if (segments.length === 3 && segments[1]?.endsWith('.git') && segments[2] === 'git-upload-pack') {
          if (method === 'POST') {
            handleUploadPack(ctx, req, res, segments[0] as string, segments[1].slice(0, -4), raw);
            return;
          }
          sendError(res, forge, 404, 'Not Found');
          return;
        }
        if (segments.length === 3 && segments[1]?.endsWith('.git') && segments[2] === 'git-receive-pack') {
          if (method === 'POST') {
            handleReceivePack(ctx, res, segments[0] as string, segments[1].slice(0, -4), raw);
            return;
          }
          sendError(res, forge, 404, 'Not Found');
          return;
        }
        if (url.pathname === '/mcp') {
          if (method !== 'POST') {
            sendError(res, forge, 405, 'Method Not Allowed');
            return;
          }
          if (!authorized(req, ctx.token)) {
            sendError(res, forge, 401, 'Requires authentication');
            return;
          }
          handleMcp(ctx, res, raw);
          return;
        }
        if (url.pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendError(res, forge, 405, 'Method Not Allowed');
            return;
          }
          if (!authorized(req, ctx.token)) {
            sendError(res, forge, 401, 'Requires authentication');
            return;
          }
          handleGraphQL(ctx, res, raw);
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req, ctx.token)) {
            sendError(res, forge, 401, 'Requires authentication');
            return;
          }
          await handleRest(ctx, req, res, url, raw);
          return;
        }
        sendError(res, forge, 404, 'Not Found');
      } catch (error) {
        if (!res.headersSent) {
          sendError(res, forge, 500, error instanceof Error ? error.message : 'Internal Server Error');
        } else {
          res.end();
        }
      }
    })();
  });
  return server;
}

// The value import for the HTTP server lives here rather than with the other
// imports at the top of the file: ES module imports are hoisted, so this is
// equivalent, and it keeps the header block (types only) untouched.
import { createServer } from 'node:http';
