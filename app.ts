// github-core-clone-01: a GitHub-compatible forge in one Node 22 stdlib-only process.
//
// Surfaces: GET /healthz, GET /api/v3/ (+ REST v3: repos, branches, commits, contents,
// issues, comments, labels, pull requests, files, merges), POST /api/graphql (v4),
// POST /mcp (streamable HTTP, 2026-07-28 + legacy initialize), git smart HTTP
// (/<owner>/<repo>.git/info/refs, git-upload-pack, git-receive-pack, protocol v0 + v2),
// else 404 {"message":"Not Found"}. Auth: Bearer $MAKEFUN_SHOP_TOKEN on every API
// route except /healthz.
//
// The store is in-memory: one trial is one process, and the suite seeds every fixture
// through the API. Object ids are real git SHA-1s; packs are real packfiles (no deltas
// on the wire, plain objects) so any git client can clone, fetch and push.
//
// The token names one user: the scenario's viewer. The suite's scenario is seeded from
// one fixed public seed, so the viewer login is derived here from that seed with the
// same deterministic generator the suite ships (wire.ts): viewer adaiversen, teammate
// quinnkeller, stranger olgabauer. Any other owner is a 404 for this token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- scenario identity

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

/** xorshift64*, the scenario's PRNG (wire.ts Rng, same stream, same seed). */
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
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

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The scenario's users, derived from the fixed seed: viewer, teammate, stranger. */
function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = scenarioUsers();
const VIEWER = USERS[0] as ScenarioUser;
const STRANGER = USERS[2] as ScenarioUser;
const VIEWER_IDENT = `${VIEWER.name} <${VIEWER.email}>`;

function nowIso(): string {
  return new Date().toISOString();
}
function nowEpochSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------- git object primitives

const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;
type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** git's tree sort: names compared as bytes, directories as name + '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

function buildCommit(fields: { tree: string; parents: readonly string[]; message: string; author: string; committer: string; timestamp: number }): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${msg}`, 'utf8');
}

interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

function buildTag(fields: { object: string; type: string; tag: string; message: string; tagger: string; timestamp: number }): Buffer {
  const msg = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${msg}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- pkt-line framing

const PKT_LINE_MAX = 65520;

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}
function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}
function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

type PktKind = 'data' | 'flush' | 'delim' | 'end';
interface Pkt {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/** Decode a pkt-line stream; throws on a malformed length prefix. */
function decodePktLines(bytes: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line length');
    const lenText = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const len = parseInt(lenText, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > bytes.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

/** Inflate one zlib stream; `bytesWritten` is the exact consumed length. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

interface PackEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly size: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
}

/**
 * Read a packfile, resolving OFS_DELTA and REF_DELTA. `resolveBase` supplies a base a
 * thin pack leaves out (an object the store already holds). Every object is hash-checked
 * by the caller through hashObject on resolution.
 */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = sha1Hex(pack.subarray(0, trailerStart));
  if (trailer !== computed) throw new Error('pack trailer does not match its bytes');

  const raw: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: PackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      const baseOffset = entryOffset - value;
      if (baseOffset < 0 || baseOffset >= entryOffset) throw new Error(`ofs-delta names an invalid base offset ${value}`);
      (entry as { baseOffset?: number }).baseOffset = baseOffset;
    } else if (typeCode === 7) {
      (entry as { baseOid?: string }).baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    (entry as { data: Buffer }).data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, PackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: PackEntry): GitObject & { oid: string } => {
    const cached = (entry as unknown as { _resolved?: GitObject & { oid: string } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _resolved?: GitObject & { oid: string } })._resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas); trailer is SHA-1 over the body. */
function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- the store

interface Label {
  name: string;
  color: string;
  description: string;
}

interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

class Forge {
  readonly repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 100000;
  nextPullId = 200000;
  nextCommentSeq = 1;
  seqCounter = 1;

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const key = repoKey(VIEWER.login, name);
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.seqCounter++,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(repoKey(owner, name));
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The commit a ref (or branch name, or oid) resolves to, or null. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (OID_RE.test(ref)) return repo.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? null;
  }

  /** Peel a tag object to its commit, else the oid itself. */
  peel(repo: Repo, oid: string): string {
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const tag = parseTag(obj.data);
      return this.peel(repo, tag.object);
    }
    return oid;
  }

  /** All objects reachable from `roots` (commits, trees, blobs, tags). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return seen;
  }

  /** Is `ancestor` reachable from `tip` (following commit parents, peeling tags)? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    const peeledTip = this.peel(repo, tip);
    const peeledAncestor = this.peel(repo, ancestor);
    if (peeledTip === peeledAncestor) return true;
    const seen = new Set<string>();
    const stack = [peeledTip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === peeledAncestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** The nearest common ancestor commit of two tips (first found walking both sides). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const pa = this.peel(repo, a);
    const pb = this.peel(repo, b);
    if (pa === pb) return pa;
    const ancestorsA = new Set<string>();
    const stackA = [pa];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stackA.push(parent);
    }
    const stackB = [pb];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stackB.push(parent);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (tip, then parents breadth-first). */
  listCommits(repo: Repo, tip: string | null): Array<{ oid: string; view: CommitView }> {
    if (tip === null) return [];
    const peeled = this.peel(repo, tip);
    const out: Array<{ oid: string; view: CommitView; stamp: number }> = [];
    const seen = new Set<string>();
    const queue: string[] = [peeled];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      const stamp = commitStamp(view);
      out.push({ oid, view, stamp });
      for (const parent of view.parents) queue.push(parent);
    }
    out.sort((x, y) => y.stamp - x.stamp);
    return out.map(({ oid, view }) => ({ oid, view }));
  }

  /** The flat path -> blob-oid map of a commit's tree (recursive). */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(repo, entry.oid, path, out);
      else out.set(path, entry.oid);
    }
    return out;
  }

  /** Build a tree object from a flat path -> blob-oid map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: Map<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit on `branch` from a flat file map; returns the commit oid. */
  commitFiles(repo: Repo, branch: string, files: Map<string, string>, message: string, parents: readonly string[]): string {
    const tree = this.buildTreeFromMap(repo, files);
    const stamp = nowEpochSec();
    const commit = buildCommit({ tree, parents, message, author: VIEWER_IDENT, committer: VIEWER_IDENT, timestamp: stamp });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The file map at a ref tip (empty when the ref does not exist). */
  filesAt(repo: Repo, ref: string | undefined): Map<string, string> {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return new Map();
    const peeled = this.peel(repo, tip);
    const obj = repo.objects.get(peeled);
    if (!obj || obj.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(obj.data).tree);
  }

  /** Diff two flat file maps; `base` is the merge-base map, `head` the head map. */
  diffMaps(base: Map<string, string>, head: Map<string, string>, repo: Repo): PullFile[] {
    const files: PullFile[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b === h) continue;
      if (b === undefined && h !== undefined) {
        const blob = repo.objects.get(h);
        const lines = blob ? countLines(blob.data) : 0;
        files.push({ filename: path, status: 'added', additions: Math.max(1, lines), deletions: 0, changes: Math.max(1, lines) });
      } else if (h === undefined && b !== undefined) {
        const blob = repo.objects.get(b);
        const lines = blob ? countLines(blob.data) : 0;
        files.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, lines), changes: Math.max(1, lines) });
      } else if (b !== undefined && h !== undefined) {
        const oldBlob = repo.objects.get(b);
        const newBlob = repo.objects.get(h);
        const { additions, deletions } = diffLines(oldBlob?.data ?? Buffer.alloc(0), newBlob?.data ?? Buffer.alloc(0));
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** Three-way merge check for a PR: null when clean, else the conflicting paths. */
  mergeConflicts(repo: Repo, headRef: string, baseRef: string): string[] | null {
    const headTip = this.resolveRef(repo, headRef);
    const baseTip = this.resolveRef(repo, baseRef);
    if (headTip === null || baseTip === null) return ['(missing ref)'];
    const base = this.mergeBase(repo, headTip, baseTip);
    const baseMap = base === null ? new Map<string, string>() : this.filesAt(repo, base);
    const headMap = this.filesAt(repo, headTip);
    const baseTipMap = this.filesAt(repo, baseTip);
    const conflicts: string[] = [];
    const paths = new Set([...baseMap.keys(), ...headMap.keys(), ...baseTipMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path);
      const h = headMap.get(path);
      const t = baseTipMap.get(path);
      const headChanged = h !== b;
      const baseChanged = t !== b;
      if (headChanged && baseChanged && h !== t) conflicts.push(path);
    }
    return conflicts.length > 0 ? conflicts : null;
  }
}

function commitStamp(view: CommitView): number {
  const match = / (\d+) [+-]\d{4}$/.exec(view.committer) ?? / (\d+) [+-]\d{4}$/.exec(view.author);
  return match ? Number(match[1]) : 0;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

/** Naive line diff: lines in new not present in old, and vice versa (min 1 when contents differ). */
function diffLines(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  if (oldData.equals(newData)) return { additions: 0, deletions: 0 };
  const oldLines = new Set(oldData.toString('utf8').split('\n'));
  const newLines = newData.toString('utf8').split('\n');
  let additions = 0;
  for (const line of newLines) if (!oldLines.has(line)) additions += 1;
  const newSet = new Set(newLines);
  let deletions = 0;
  for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
  return { additions: Math.max(1, additions), deletions };
}

// ---------------------------------------------------------------- HTTP plumbing

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

function unprocessable(res: ServerResponse, message: string): void {
  sendJson(res, 422, { message });
}

/** The bearer token is valid when it matches the shop token (any non-empty one when unset). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  segments: string[];
  body: Buffer;
  json: unknown;
  jsonOk: boolean;
  forge: Forge;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: boolean; value: unknown } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, value: undefined };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strField(obj: Record<string, unknown>, field: string, fallback = ''): string {
  const value = obj[field];
  return typeof value === 'string' ? value : fallback;
}

function boolField(obj: Record<string, unknown>, field: string, fallback = false): boolean {
  const value = obj[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse page/per_page (GitHub defaults: page 1, per_page 30). */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { items: T[]; total: number; pages: number } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), total, pages };
}

/** GitHub's Link header for a paginated collection (absolute URLs, same origin). */
function linkHeader(ctx: Ctx, page: number, perPage: number, pages: number): string {
  const host = ctx.req.headers.host ?? 'localhost';
  const proto = 'http';
  const base = `${proto}://${host}${ctx.path}`;
  const query = new URLSearchParams(ctx.query);
  const urlFor = (p: number): string => {
    query.set('page', String(p));
    query.set('per_page', String(perPage));
    return `<${base}?${query.toString()}>`;
  };
  const parts: string[] = [];
  if (page < pages) parts.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${urlFor(page - 1)}; rel="prev"`);
  parts.push(`${urlFor(1)}; rel="first"`);
  parts.push(`${urlFor(pages)}; rel="last"`);
  return parts.join(', ');
}

function withPagination<T>(ctx: Ctx, items: readonly T[]): { items: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.query);
  const sliced = paginate(items, page, perPage);
  return { items: sliced.items, headers: { link: linkHeader(ctx, page, perPage, sliced.pages) } };
}

// ---------------------------------------------------------------- REST shapes

function userJson(login: string): Record<string, unknown> {
  return { login, id: VIEWER.id, avatar_url: '', html_url: '', type: 'User', site_admin: false };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repoKey(repo.owner, repo.name)),
    name: repo.name,
    full_name: repoKey(repo.owner, repo.name),
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: '',
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: globalId('Label', label.name), node_id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repoKey(repo.owner, repo.name)}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(issue.userLogin),
    labels: issue.labels.map(labelJson),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repoKey(repo.owner, repo.name)}#${issue.number}:${comment.id}`),
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repoKey(repo.owner, repo.name)}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userJson(pull.userLogin),
    labels: [],
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: headSha, user: userJson(repo.owner), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: baseSha, user: userJson(repo.owner), repo: repoJson(repo) },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? (forge.mergeConflicts(repo, pull.headRef, pull.baseRef) === null ? 'MERGEABLE' : 'CONFLICTING') : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    author_association: 'OWNER',
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha, url: '' }, protected: false };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: nowIso() };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(oid: string, view: CommitView): Record<string, unknown> {
  const author = parseIdent(view.author);
  const committer = parseIdent(view.committer);
  return {
    sha: oid,
    commit: {
      // GitHub strips the commit object's trailing newline from the message.
      message: view.message.replace(/\n+$/, ''),
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: view.tree },
    },
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
    parents: view.parents.map((sha) => ({ sha })),
    url: '',
  };
}

// ---------------------------------------------------------------- REST: repos, branches, commits, contents, git refs

function contentsFileJson(path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: '',
    html_url: '',
    download_url: '',
    _links: { self: '', git: '', html: '' },
  };
}

function contentsDirEntry(path: string, entry: TreeEntry, repo: Repo): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  let size = 0;
  if (!isDir) {
    const obj = repo.objects.get(entry.oid);
    size = obj ? obj.data.length : 0;
  }
  return { type: isDir ? 'dir' : 'file', size, name: entry.name, path, sha: entry.oid, url: '', html_url: '', download_url: isDir ? null : '' };
}

/** Resolve a tree object at `path` inside a commit's tree; null when absent. */
function treeAtPath(repo: Repo, rootTree: string, segments: readonly string[]): { type: 'tree' | 'blob'; oid: string } | null {
  let current = rootTree;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return { type: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { type: 'tree', oid: rootTree };
}

function handleRepoRoutes(ctx: Ctx): boolean {
  const forge = ctx.forge;
  const seg = ctx.segments;
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const rest = seg.slice(2);

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (ctx.method !== 'GET') return false;
    sendJson(ctx.res, 200, {
      current_user_url: '',
      current_user_authorizations_html_url: '',
      authorizations_url: '',
      code_search_url: '',
      commit_search_url: '',
      emails_url: '',
      emojis_url: '',
      events_url: '',
      feeds_url: '',
      followers_url: '',
      following_url: '',
      gists_url: '',
      hub_url: '',
      issue_search_url: '',
      issues_url: '',
      keys_url: '',
      labels_url: '',
      markdown_url: '',
      notifications_url: '',
      organization_repositories_url: '',
      organization_url: '',
      public_gists_url: '',
      rate_limit_url: '',
      repository_url: '',
      repository_search_url: '',
      current_user_repositories_url: '',
      search_url: '',
      starred_url: '',
      starred_gists_url: '',
      user_url: '',
      user_organizations_url: '',
      user_repositories_url: '',
      user_search_url: '',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (rest[0] === 'meta') {
    if (ctx.method !== 'GET') return false;
    sendJson(ctx.res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, git: ['1.0.0'], github_services_sha: '' });
    return true;
  }

  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (ctx.method !== 'GET') return false;
      sendJson(ctx.res, 200, {
        login: VIEWER.login,
        id: VIEWER.id,
        node_id: globalId('User', VIEWER.login),
        avatar_url: '',
        gravatar_id: '',
        url: '',
        html_url: '',
        type: 'User',
        site_admin: false,
        name: VIEWER.name,
        company: null,
        blog: '',
        location: null,
        email: VIEWER.email,
        hireable: null,
        bio: null,
        twitter_username: null,
        public_repos: forge.repos.size,
        public_gists: 0,
        followers: 0,
        following: 0,
        created_at: '2026-11-14T00:00:00Z',
        updated_at: nowIso(),
      });
      return true;
    }
    if (rest[1] === 'repos') {
      if (ctx.method === 'GET') {
        const all = [...forge.repos.values()].sort((a, b) => a.id - b.id).map(repoJson);
        const page = withPagination(ctx, all);
        sendJson(ctx.res, 200, page.items, page.headers);
        return true;
      }
      if (ctx.method === 'POST') {
        const body = asRecord(ctx.json);
        if (!body) {
          unprocessable(ctx.res, 'Invalid request');
          return true;
        }
        const name = strField(body, 'name');
        if (name === '') {
          unprocessable(ctx.res, 'name is required');
          return true;
        }
        if (forge.getRepo(VIEWER.login, name)) {
          unprocessable(ctx.res, 'name already exists on this account');
          return true;
        }
        const repo = forge.createRepo(name, boolField(body, 'private'), strField(body, 'description'));
        sendJson(ctx.res, 201, repoJson(repo));
        return true;
      }
      return false;
    }
    return false;
  }

  if (rest[0] !== 'repos' || rest.length < 3) return false;
  const owner = decodeURIComponent(rest[1] as string);
  const name = decodeURIComponent(rest[2] as string);
  const tail = rest.slice(3);
  const repo = forge.getRepo(owner, name);
  if (!repo) {
    notFound(ctx.res);
    return true;
  }

  // /repos/:owner/:repo itself
  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(ctx.res, 200, repoJson(repo));
      return true;
    }
    if (ctx.method === 'PATCH') {
      const body = asRecord(ctx.json);
      if (body) {
        const description = body['description'];
        if (typeof description === 'string') repo.description = description;
        repo.updatedAt = nowIso();
      }
      sendJson(ctx.res, 200, repoJson(repo));
      return true;
    }
    if (ctx.method === 'DELETE') {
      forge.deleteRepo(owner, name);
      sendEmpty(ctx.res, 204);
      return true;
    }
    return false;
  }

  // Branches
  if (tail[0] === 'branches') {
    if (ctx.method !== 'GET') return false;
    if (tail.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => branchJson(repo, branch, repo.refs.get(`refs/heads/${branch}`) as string));
      const page = withPagination(ctx, branches);
      sendJson(ctx.res, 200, page.items, page.headers);
      return true;
    }
    const branch = tail.slice(1).map(decodeURIComponent).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) {
      notFound(ctx.res, 'Branch not found');
      return true;
    }
    sendJson(ctx.res, 200, branchJson(repo, branch, sha));
    return true;
  }

  // Commits
  if (tail[0] === 'commits') {
    if (ctx.method !== 'GET') return false;
    if (tail.length === 1) {
      const tip = forge.resolveRef(repo, ctx.query.get('sha') ?? undefined);
      const commits = forge.listCommits(repo, tip).map(({ oid, view }) => commitJson(oid, view));
      const page = withPagination(ctx, commits);
      sendJson(ctx.res, 200, page.items, page.headers);
      return true;
    }
    const sha = decodeURIComponent(tail[1] as string);
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') {
      notFound(ctx.res, 'No commit found for SHA: ' + sha);
      return true;
    }
    sendJson(ctx.res, 200, commitJson(sha, parseCommit(obj.data)));
    return true;
  }

  // Contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).map(decodeURIComponent).join('/');
    const branch = ctx.query.get('ref') ?? undefined;
    if (ctx.method === 'GET') {
      const tip = forge.resolveRef(repo, branch);
      if (tip === null) {
        notFound(ctx.res, 'This repository is empty.');
        return true;
      }
      const peeled = forge.peel(repo, tip);
      const commitObj = repo.objects.get(peeled);
      if (!commitObj || commitObj.type !== 'commit') {
        notFound(ctx.res);
        return true;
      }
      const rootTree = parseCommit(commitObj.data).tree;
      if (path === '') {
        const entries = parseTree(repo.objects.get(rootTree)?.data ?? Buffer.alloc(0)).map((entry) => contentsDirEntry(entry.name, entry, repo));
        sendJson(ctx.res, 200, entries);
        return true;
      }
      const segments = path.split('/').filter((part) => part !== '');
      const found = treeAtPath(repo, rootTree, segments);
      if (!found) {
        notFound(ctx.res);
        return true;
      }
      if (found.type === 'blob') {
        const blob = repo.objects.get(found.oid);
        if (!blob) {
          notFound(ctx.res);
          return true;
        }
        sendJson(ctx.res, 200, contentsFileJson(path, found.oid, blob.data));
        return true;
      }
      const entries = parseTree(repo.objects.get(found.oid)?.data ?? Buffer.alloc(0)).map((entry) => contentsDirEntry(`${path}/${entry.name}`, entry, repo));
      sendJson(ctx.res, 200, entries);
      return true;
    }
    if (ctx.method === 'PUT') {
      const body = asRecord(ctx.json);
      if (!body) {
        unprocessable(ctx.res, 'Invalid request');
        return true;
      }
      const contentB64 = strField(body, 'content');
      const message = strField(body, 'message', path === '' ? 'Update file' : `Update ${path}`);
      const branchName = strField(body, 'branch') || repo.defaultBranch;
      if (path === '' || contentB64 === '') {
        unprocessable(ctx.res, 'content is required');
        return true;
      }
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        unprocessable(ctx.res, 'content is not valid base64');
        return true;
      }
      const existing = forge.filesAt(repo, branchName);
      const currentOid = existing.get(path);
      const givenSha = strField(body, 'sha');
      if (currentOid !== undefined) {
        if (givenSha === '') {
          sendJson(ctx.res, 409, { message: 'sha is required to update a file' });
          return true;
        }
        if (givenSha !== currentOid) {
          sendJson(ctx.res, 409, { message: 'sha does not match the current file' });
          return true;
        }
      } else if (givenSha !== '') {
        unprocessable(ctx.res, 'Invalid sha');
        return true;
      }
      const tip = forge.resolveRef(repo, branchName);
      const newBlob = forge.putObject(repo, 'blob', content);
      const files = new Map(existing);
      files.set(path, newBlob);
      const parents = tip === null ? [] : [forge.peel(repo, tip)];
      const commitOid = forge.commitFiles(repo, branchName, files, message, parents);
      repo.updatedAt = nowIso();
      sendJson(ctx.res, currentOid === undefined ? 201 : 200, {
        content: contentsFileJson(path, newBlob, content),
        commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
      });
      return true;
    }
    if (ctx.method === 'DELETE') {
      const body = asRecord(ctx.json);
      if (!body) {
        unprocessable(ctx.res, 'Invalid request');
        return true;
      }
      const branchName = strField(body, 'branch') || repo.defaultBranch;
      const message = strField(body, 'message', `Delete ${path}`);
      const existing = forge.filesAt(repo, branchName);
      const currentOid = existing.get(path);
      if (currentOid === undefined) {
        notFound(ctx.res);
        return true;
      }
      const givenSha = strField(body, 'sha');
      if (givenSha !== '' && givenSha !== currentOid) {
        sendJson(ctx.res, 409, { message: 'sha does not match the current file' });
        return true;
      }
      const tip = forge.resolveRef(repo, branchName);
      const files = new Map(existing);
      files.delete(path);
      const parents = tip === null ? [] : [forge.peel(repo, tip)];
      const commitOid = forge.commitFiles(repo, branchName, files, message, parents);
      repo.updatedAt = nowIso();
      sendJson(ctx.res, 200, {
        content: null,
        commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
      });
      return true;
    }
    return false;
  }

  // Git refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (ctx.method === 'POST' && tail.length === 2) {
      const body = asRecord(ctx.json);
      if (!body) {
        unprocessable(ctx.res, 'Invalid request');
        return true;
      }
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (!ref.startsWith('refs/') || !OID_RE.test(sha) || !repo.objects.has(sha)) {
        unprocessable(ctx.res, 'Invalid request.\n\n"ref" must start with "refs/" and "sha" must be an existing object.');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(ctx.res, 422, { message: 'Reference already exists', errors: [{ resource: 'Reference', code: 'already_exists', field: 'ref' }] });
        return true;
      }
      repo.refs.set(ref, sha);
      repo.updatedAt = nowIso();
      sendJson(ctx.res, 201, { ref, node_id: globalId('Ref', `${repoKey(owner, name)}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
      return true;
    }
    if (ctx.method === 'GET') {
      if (tail.length === 2) {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ ref, node_id: globalId('Ref', `${repoKey(owner, name)}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }));
        const page = withPagination(ctx, refs);
        sendJson(ctx.res, 200, page.items, page.headers);
        return true;
      }
      const ref = `refs/${tail.slice(2).map(decodeURIComponent).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        notFound(ctx.res);
        return true;
      }
      sendJson(ctx.res, 200, { ref, node_id: globalId('Ref', `${repoKey(owner, name)}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
      return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------- REST: issues, comments, labels, pulls

function normalizeBranchRef(value: string, owner: string): string {
  const prefix = `${owner}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function handleCollabRoutes(ctx: Ctx): boolean {
  const forge = ctx.forge;
  const seg = ctx.segments;
  if (seg.length < 6 || seg[0] !== 'api' || seg[1] !== 'v3' || seg[2] !== 'repos') return false;
  const owner = decodeURIComponent(seg[3] as string);
  const name = decodeURIComponent(seg[4] as string);
  const tail = seg.slice(5);
  const repo = forge.getRepo(owner, name);
  if (!repo) {
    notFound(ctx.res);
    return true;
  }

  // Labels
  if (tail[0] === 'labels') {
    if (ctx.method === 'GET' && tail.length === 1) {
      const labels = [...repo.labels.values()].map(labelJson);
      const page = withPagination(ctx, labels);
      sendJson(ctx.res, 200, page.items, page.headers);
      return true;
    }
    if (ctx.method === 'POST' && tail.length === 1) {
      const body = asRecord(ctx.json);
      if (!body) {
        unprocessable(ctx.res, 'Invalid request');
        return true;
      }
      const labelName = strField(body, 'name');
      if (labelName === '') {
        unprocessable(ctx.res, 'name is required');
        return true;
      }
      if (repo.labels.has(labelName)) {
        sendJson(ctx.res, 422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] });
        return true;
      }
      const label: Label = {
        name: labelName,
        color: strField(body, 'color', '000000').replace(/^#/, ''),
        description: strField(body, 'description'),
      };
      repo.labels.set(labelName, label);
      sendJson(ctx.res, 201, labelJson(label));
      return true;
    }
    return false;
  }

  // Issues
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        const labelFilter = ctx.query.get('labels');
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        if (labelFilter) {
          const wanted = labelFilter.split(',').map((part) => part.trim());
          list = list.filter((issue) => wanted.every((w) => issue.labels.some((label) => label.name === w)));
        }
        list.sort((a, b) => {
          let cmp: number;
          if (sort === 'updated') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.seq - b.seq;
          else cmp = a.seq - b.seq;
          return direction === 'asc' ? cmp : -cmp;
        });
        const page = withPagination(ctx, list.map((issue) => issueJson(repo, issue)));
        sendJson(ctx.res, 200, page.items, page.headers);
        return true;
      }
      if (ctx.method === 'POST') {
        const body = asRecord(ctx.json);
        if (!body) {
          unprocessable(ctx.res, 'Invalid request');
          return true;
        }
        const title = strField(body, 'title');
        if (title === '') {
          unprocessable(ctx.res, 'title is required');
          return true;
        }
        const labelNames = Array.isArray(body['labels']) ? (body['labels'] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (!label) {
            unprocessable(ctx.res, `Invalid label: ${labelName}`);
            return true;
          }
          labels.push(label);
        }
        const now = nowIso();
        const issue: Issue = {
          id: forge.nextIssueId++,
          number: repo.nextNumber++,
          title,
          body: strField(body, 'body'),
          state: 'open',
          labels,
          comments: [],
          userLogin: VIEWER.login,
          createdAt: now,
          updatedAt: now,
          seq: repo.seq++,
        };
        repo.issues.set(issue.number, issue);
        sendJson(ctx.res, 201, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isInteger(number)) return false;
    const issue = repo.issues.get(number);
    if (tail.length === 2) {
      if (!issue) {
        notFound(ctx.res);
        return true;
      }
      if (ctx.method === 'GET') {
        sendJson(ctx.res, 200, issueJson(repo, issue));
        return true;
      }
      if (ctx.method === 'PATCH') {
        const body = asRecord(ctx.json);
        if (body) {
          const title = body['title'];
          if (typeof title === 'string') issue.title = title;
          const bodyText = body['body'];
          if (typeof bodyText === 'string') issue.body = bodyText;
          const state = body['state'];
          if (state === 'open' || state === 'closed') issue.state = state;
          const labelNames = body['labels'];
          if (Array.isArray(labelNames)) {
            const labels: Label[] = [];
            let bad: string | null = null;
            for (const item of labelNames as unknown[]) {
              if (typeof item !== 'string') continue;
              const label = repo.labels.get(item);
              if (!label) {
                bad = item;
                break;
              }
              labels.push(label);
            }
            if (bad !== null) {
              unprocessable(ctx.res, `Invalid label: ${bad}`);
              return true;
            }
            issue.labels = labels;
          }
          issue.updatedAt = nowIso();
        }
        sendJson(ctx.res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (tail[2] === 'comments') {
      if (!issue) {
        notFound(ctx.res);
        return true;
      }
      if (ctx.method === 'GET' && tail.length === 3) {
        const page = withPagination(ctx, issue.comments.map((comment) => commentJson(repo, issue, comment)));
        sendJson(ctx.res, 200, page.items, page.headers);
        return true;
      }
      if (ctx.method === 'POST' && tail.length === 3) {
        const body = asRecord(ctx.json);
        if (!body || strField(body, 'body') === '') {
          unprocessable(ctx.res, 'body is required');
          return true;
        }
        const now = nowIso();
        const comment: IssueComment = {
          id: repo.nextCommentId++,
          body: strField(body, 'body'),
          userLogin: VIEWER.login,
          createdAt: now,
          updatedAt: now,
        };
        issue.comments.push(comment);
        issue.updatedAt = now;
        sendJson(ctx.res, 201, commentJson(repo, issue, comment));
        return true;
      }
      return false;
    }
    return false;
  }

  // Pull requests
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (ctx.method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        list.sort((a, b) => {
          const cmp = sort === 'updated' ? (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.seq - b.seq) : a.seq - b.seq;
          return direction === 'asc' ? cmp : -cmp;
        });
        const page = withPagination(ctx, list.map((pull) => pullJson(forge, repo, pull)));
        sendJson(ctx.res, 200, page.items, page.headers);
        return true;
      }
      if (ctx.method === 'POST') {
        const body = asRecord(ctx.json);
        if (!body) {
          unprocessable(ctx.res, 'Invalid request');
          return true;
        }
        const title = strField(body, 'title');
        if (title === '') {
          unprocessable(ctx.res, 'title is required');
          return true;
        }
        const head = normalizeBranchRef(strField(body, 'head'), owner);
        const base = normalizeBranchRef(strField(body, 'base'), owner);
        if (head === '' || base === '') {
          unprocessable(ctx.res, 'head and base are required');
          return true;
        }
        const headTip = forge.resolveRef(repo, head);
        const baseTip = forge.resolveRef(repo, base);
        if (headTip === null) {
          unprocessable(ctx.res, `Invalid head branch: ${head}`);
          return true;
        }
        if (baseTip === null) {
          unprocessable(ctx.res, `Invalid base branch: ${base}`);
          return true;
        }
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
            unprocessable(ctx.res, `A pull request already exists for ${owner}:${head}`);
            return true;
          }
        }
        const now = nowIso();
        const pull: Pull = {
          id: forge.nextPullId++,
          number: repo.nextNumber++,
          title,
          body: strField(body, 'body'),
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          baseRef: base,
          userLogin: VIEWER.login,
          createdAt: now,
          updatedAt: now,
          seq: repo.seq++,
        };
        repo.pulls.set(pull.number, pull);
        sendJson(ctx.res, 201, pullJson(forge, repo, pull));
        return true;
      }
      return false;
    }
    const number = Number.parseInt(tail[1] as string, 10);
    if (!Number.isInteger(number)) return false;
    const pull = repo.pulls.get(number);
    if (tail.length === 2) {
      if (!pull) {
        notFound(ctx.res);
        return true;
      }
      if (ctx.method === 'GET') {
        sendJson(ctx.res, 200, pullJson(forge, repo, pull));
        return true;
      }
      return false;
    }
    if (tail[2] === 'files' && tail.length === 3) {
      if (ctx.method !== 'GET') return false;
      if (!pull) {
        notFound(ctx.res);
        return true;
      }
      const headTip = forge.resolveRef(repo, pull.headRef);
      const baseTip = forge.resolveRef(repo, pull.baseRef);
      if (headTip === null || baseTip === null) {
        sendJson(ctx.res, 200, []);
        return true;
      }
      const base = forge.mergeBase(repo, headTip, baseTip);
      const baseMap = base === null ? new Map<string, string>() : forge.filesAt(repo, base);
      const headMap = forge.filesAt(repo, headTip);
      const files = forge.diffMaps(baseMap, headMap, repo);
      const page = withPagination(ctx, files);
      sendJson(ctx.res, 200, page.items, page.headers);
      return true;
    }
    if (tail[2] === 'merge' && tail.length === 3) {
      if (ctx.method !== 'PUT') return false;
      if (!pull) {
        notFound(ctx.res);
        return true;
      }
      if (pull.state !== 'open') {
        sendJson(ctx.res, 405, { message: 'Pull request is not mergeable' });
        return true;
      }
      const headTip = forge.resolveRef(repo, pull.headRef);
      const baseTip = forge.resolveRef(repo, pull.baseRef);
      if (headTip === null || baseTip === null) {
        sendJson(ctx.res, 405, { message: 'Pull request is not mergeable' });
        return true;
      }
      if (forge.isAncestor(repo, headTip, baseTip)) {
        sendJson(ctx.res, 405, { message: 'Head is already merged into base' });
        return true;
      }
      const conflicts = forge.mergeConflicts(repo, pull.headRef, pull.baseRef);
      if (conflicts !== null) {
        sendJson(ctx.res, 405, { message: `Merge conflict in ${conflicts.join(', ')}` });
        return true;
      }
      // Squash: base tip tree overlaid with the head's changes since the merge base.
      const base = forge.mergeBase(repo, headTip, baseTip);
      const baseMap = base === null ? new Map<string, string>() : forge.filesAt(repo, base);
      const headMap = forge.filesAt(repo, headTip);
      const resultMap = forge.filesAt(repo, baseTip);
      for (const [path, oid] of headMap) {
        if (baseMap.get(path) !== oid) resultMap.set(path, oid);
      }
      for (const path of baseMap.keys()) {
        if (!headMap.has(path) && resultMap.get(path) === baseMap.get(path)) resultMap.delete(path);
      }
      const message = `Merge pull request #${pull.number} from ${owner}/${pull.headRef}\n\n${pull.title}`;
      const squashOid = forge.commitFiles(repo, pull.baseRef, resultMap, message, [forge.peel(repo, baseTip)]);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = squashOid;
      pull.updatedAt = nowIso();
      repo.updatedAt = nowIso();
      sendJson(ctx.res, 200, { merged: true, sha: squashOid, message: `Pull Request successfully merged` });
      return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------- git smart HTTP

const UPLOAD_PACK_CAPS_V2 = [
  'ls-refs=unborn',
  'fetch=shallow wait-for-done unborn',
  'object-format=sha1',
  'object-info',
  'agent=github-core-clone/1.0.0',
];
const UPLOAD_PACK_CAPS_V0 =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done object-format=sha1 agent=github-core-clone/1.0.0';
const RECEIVE_PACK_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta quiet agent=github-core-clone/1.0.0';

/** Refs sorted heads-then-tags, with peeled lines for annotated tags. */
function advertisedRefs(forge: Forge, repo: Repo): Array<{ line: string; ref: string; oid: string }> {
  const out: Array<{ line: string; ref: string; oid: string }> = [];
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of [...heads, ...tags]) {
    const oid = repo.refs.get(ref) as string;
    out.push({ line: `${oid} ${ref}\n`, ref, oid });
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = forge.peel(repo, oid);
      out.push({ line: `${peeled} ${ref}^{}\n`, ref: `${ref}^{}`, oid: peeled });
    }
  }
  return out;
}

function advertiseUploadPackV0(forge: Forge, repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
  const refs = advertisedRefs(forge, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_PACK_CAPS_V0}\n`));
  } else {
    refs.forEach((entry, index) => {
      parts.push(index === 0 ? pktLine(entry.line.replace('\n', `\0${UPLOAD_PACK_CAPS_V0}\n`)) : pktLine(entry.line));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseReceivePackV0(forge: Forge, repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush()];
  const refs = advertisedRefs(forge, repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_PACK_CAPS_V0}\n`));
  } else {
    refs.forEach((entry, index) => {
      parts.push(index === 0 ? pktLine(entry.line.replace('\n', `\0${RECEIVE_PACK_CAPS_V0}\n`)) : pktLine(entry.line));
    });
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseUploadPackV2(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush(), pktLine('version 2\n')];
  for (const cap of UPLOAD_PACK_CAPS_V2) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Split a sideband payload into band-N pkt-lines (data chunk <= 65515 bytes). */
function sideband(band: number, data: Buffer): Buffer {
  // The band is one byte holding the numeric value 1/2/3, NOT the ASCII digit.
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) {
    const chunk = data.subarray(offset, Math.min(offset + 65515, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([band])));
  return Buffer.concat(parts);
}

interface FetchPlan {
  readonly wants: string[];
  readonly haves: string[];
  readonly deepen: number | null;
  readonly oldShallow: string[];
}

/** Commits within `depth` generations of `wants` (depth 1 = the tips only). */
function depthLimitedCommits(forge: Forge, repo: Repo, wants: readonly string[], depth: number): Set<string> {
  const out = new Set<string>();
  const queue: Array<{ oid: string; level: number }> = wants.map((oid) => ({ oid: forge.peel(repo, oid), level: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, level } = queue.shift() as { oid: string; level: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    if (level >= depth) continue;
    out.add(oid);
    if (level + 1 < depth) {
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, level: level + 1 });
    }
  }
  return out;
}

/** The objects a shallow fetch sends for one commit: the commit itself plus its
 *  tree closure (trees + blobs), never its parents. */
function commitTreeObjects(repo: Repo, commitOid: string, out: Set<string>): void {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return;
  out.add(commitOid);
  const stack = [parseCommit(obj.data).tree];
  while (stack.length > 0) {
    const treeOid = stack.pop() as string;
    if (out.has(treeOid)) continue;
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') continue;
    out.add(treeOid);
    for (const entry of parseTree(treeObj.data)) {
      if (entry.mode === '40000') stack.push(entry.oid);
      else if (repo.objects.has(entry.oid)) out.add(entry.oid);
    }
  }
}

/** The objects a client already holds: the closure of its haves, but never past a
 *  shallow boundary commit (a shallow clone holds the boundary commit and its
 *  tree, not its parents). With no shallow lines this is plain reachability. */
function heldObjects(forge: Forge, repo: Repo, haves: readonly string[], shallow: readonly string[]): Set<string> {
  const boundary = new Set(shallow.map((oid) => forge.peel(repo, oid)));
  const seen = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      if (!boundary.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** The object set a fetch sends: want closures minus have closures, depth-limited. */
function planFetchObjects(forge: Forge, repo: Repo, plan: FetchPlan): { objects: GitObject[]; included: Set<string>; boundary: Set<string> } {
  const peeledWants = plan.wants.map((oid) => forge.peel(repo, oid));
  let includedCommits: Set<string>;
  if (plan.deepen !== null) {
    includedCommits = depthLimitedCommits(forge, repo, peeledWants, plan.deepen);
  } else {
    includedCommits = new Set<string>();
    const stack = [...peeledWants];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      includedCommits.add(oid);
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
  }
  const held = heldObjects(forge, repo, plan.haves, plan.oldShallow);
  const send = new Set<string>();
  for (const oid of includedCommits) {
    if (held.has(oid)) continue;
    if (plan.deepen !== null) commitTreeObjects(repo, oid, send);
    else {
      const reachableFromCommit = forge.reachable(repo, [oid]);
      for (const reachableOid of reachableFromCommit) send.add(reachableOid);
    }
  }
  for (const heldOid of held) send.delete(heldOid);
  // Wanted tags themselves always travel with the fetch.
  for (const oid of plan.wants) {
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag' && !held.has(oid)) send.add(oid);
  }
  // The depth boundary: included commits whose parents are not included.
  const boundary = new Set<string>();
  if (plan.deepen !== null) {
    for (const oid of includedCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0 || parents.some((parent) => !includedCommits.has(parent))) boundary.add(oid);
    }
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const obj = repo.objects.get(oid);
    if (obj) objects.push(obj);
  }
  return { objects, included: includedCommits, boundary };
}

function handleLsRefsV2(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  // A ref is returned when it matches any given prefix; with no prefix, all refs
  // are returned. HEAD is a ref named "HEAD": it is returned exactly when a
  // prefix matches it (e.g. a client asking for ref-prefix HEAD gets the HEAD
  // line, while a client asking for ref-prefix refs/heads/ does not).
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const lines: string[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  if (matches('HEAD')) {
    if (defaultTip !== undefined) {
      const headLine = symrefs ? `${defaultTip} HEAD symref-target:${defaultRef}\n` : `${defaultTip} HEAD\n`;
      lines.push(headLine);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${defaultRef}\n`);
    }
  }
  for (const entry of advertisedRefs(forge, repo)) {
    // v2 ls-refs has one line per ref: a peeled tag carries `peeled:<commit>`
    // on its own line. The v0 `^{}` pseudo-ref is never a v2 line — a client
    // that finds the plain line first reads peeled as missing.
    if (entry.ref.endsWith('^{}')) continue;
    const ref = entry.ref;
    if (!matches(ref)) continue;
    let line = entry.line;
    if (peel) {
      const obj = repo.objects.get(entry.oid);
      if (obj && obj.type === 'tag') line = `${entry.oid} ${ref} peeled:${forge.peel(repo, entry.oid)}\n`;
    }
    lines.push(line);
  }
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV2(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) oldShallow.push(arg.slice(8).trim());
    else if (arg === 'done') done = true;
    else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isInteger(value) && value > 0) deepen = value;
    }
  }
  const plan: FetchPlan = { wants, haves, deepen, oldShallow };
  const { objects, included, boundary } = planFetchObjects(forge, repo, plan);
  const parts: Buffer[] = [];
  if (!done) {
    // Negotiation round (no "done" yet): acknowledgments only, no packfile.
    // The client follows up with more haves or with "done".
    parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush());
    return Buffer.concat(parts);
  }
  // The client sent "done": protocol-v2 requires the acknowledgments section
  // to be omitted, so the response starts with shallow-info or packfile.
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (deepen !== null) {
    for (const oid of boundary) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of oldShallow) if (included.has(oid)) unshallowLines.push(`unshallow ${oid}\n`);
  } else {
    for (const oid of oldShallow) {
      if (included.has(oid)) unshallowLines.push(`unshallow ${oid}\n`);
      else shallowLines.push(`shallow ${oid}\n`);
    }
  }
  if (shallowLines.length > 0 || unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of [...shallowLines, ...unshallowLines]) parts.push(pktLine(line));
    parts.push(pktDelim());
  }
  if (objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(sideband(1, writePack(objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let deepen: number | null = null;
  for (const arg of args) {
    // In v0 the first want line carries capabilities after the oid, space-separated.
    if (arg.startsWith('want ')) wants.push(arg.slice(5).split(/[\0 ]/)[0]?.trim() ?? '');
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) oldShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isInteger(value) && value > 0) deepen = value;
    }
  }
  const plan: FetchPlan = { wants, haves, deepen, oldShallow };
  const { objects, included, boundary } = planFetchObjects(forge, repo, plan);
  const parts: Buffer[] = [pktLine('NAK\n')];
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (deepen !== null) {
    for (const oid of boundary) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of oldShallow) if (included.has(oid)) unshallowLines.push(`unshallow ${oid}\n`);
  } else {
    for (const oid of oldShallow) {
      if (included.has(oid)) unshallowLines.push(`unshallow ${oid}\n`);
      else shallowLines.push(`shallow ${oid}\n`);
    }
  }
  for (const line of [...shallowLines, ...unshallowLines]) parts.push(pktLine(line));
  if (objects.length > 0) parts.push(sideband(1, writePack(objects)));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a v2 request body into the command + its arguments (pkt-lines up to flush). */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const lines = decodePktLines(body);
  const args: string[] = [];
  let command = '';
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('command=')) command = text.slice('command='.length);
    else if (text.startsWith('version ')) continue;
    else if (text !== '') args.push(text);
  }
  return { command, args };
}

function handleUploadPack(ctx: Ctx, repo: Repo): boolean {
  const forge = ctx.forge;
  const body = ctx.body;
  const isV2 = ctx.req.headers['git-protocol'] === 'version=2' || body.subarray(0, 12).toString('ascii').includes('version 2');
  try {
    if (isV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        sendRaw(ctx.res, 200, 'application/x-git-upload-pack-result', handleLsRefsV2(forge, repo, args));
        return true;
      }
      if (command === 'fetch') {
        sendRaw(ctx.res, 200, 'application/x-git-upload-pack-result', handleFetchV2(forge, repo, args));
        return true;
      }
      sendJson(ctx.res, 400, { message: `Unknown command: ${command}` });
      return true;
    }
    const lines = decodePktLines(body);
    const args: string[] = [];
    // v0 sends two sections (wants, then haves + done), each ended by a flush:
    // collect data lines from both, never stop at the first flush.
    for (const line of lines) {
      if (line.kind !== 'data') continue;
      const text = line.payload.toString('utf8').replace(/\n$/, '');
      if (text !== '') args.push(text);
    }
    sendRaw(ctx.res, 200, 'application/x-git-upload-pack-result', handleFetchV0(forge, repo, args));
    return true;
  } catch (error) {
    sendJson(ctx.res, 400, { message: error instanceof Error ? error.message : 'Bad upload-pack request' });
    return true;
  }
}

function handleReceivePack(ctx: Ctx, repo: Repo): boolean {
  const forge = ctx.forge;
  const body = ctx.body;
  const report = (lines: string[]): Buffer => {
    const reportLines = lines.map((line) => pktLine(`${line}\n`));
    return Buffer.concat([sideband(1, Buffer.concat(reportLines)), pktFlush()]);
  };
  try {
    // Command pkt-lines run to the first flush; everything after it is the raw pack.
    let offset = 0;
    const commands: Array<{ old: string; next: string; ref: string }> = [];
    while (offset < body.length) {
      if (offset + 4 > body.length) throw new Error('truncated pkt-line in receive-pack');
      const lenText = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error('bad pkt-line length in receive-pack');
      const len = parseInt(lenText, 16);
      if (len === 0) {
        offset += 4;
        break;
      }
      if (len < 4 || offset + len > body.length) throw new Error('truncated command pkt-line');
      const text = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
      offset += len;
      const nul = text.indexOf('\0');
      const commandText = nul >= 0 ? text.slice(0, nul) : text;
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(commandText);
      if (!match) throw new Error(`bad receive-pack command: ${JSON.stringify(commandText)}`);
      commands.push({ old: match[1] as string, next: match[2] as string, ref: match[3] as string });
    }
    const packBytes = body.subarray(offset);
    let stored = 0;
    if (packBytes.length > 0) {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) {
          repo.objects.set(oid, object);
          stored += 1;
        }
      }
    }
    void stored;
    const reportLines: string[] = ['unpack ok'];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.next === ZERO_OID) {
        if (current === undefined) {
          reportLines.push(`ng ${command.ref} reference does not exist`);
        } else if (command.old !== ZERO_OID && command.old !== current) {
          reportLines.push(`ng ${command.ref} non-fast-forward`);
        } else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (!repo.objects.has(command.next)) {
        reportLines.push(`ng ${command.ref} object not found`);
        continue;
      }
      if (command.old === ZERO_OID) {
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} reference already exists`);
        } else {
          repo.refs.set(command.ref, command.next);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (current !== command.old) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (!forge.isAncestor(repo, command.old, command.next)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.next);
      reportLines.push(`ok ${command.ref}`);
    }
    repo.updatedAt = nowIso();
    sendRaw(ctx.res, 200, 'application/x-git-receive-pack-result', report(reportLines));
    return true;
  } catch (error) {
    sendRaw(ctx.res, 200, 'application/x-git-receive-pack-result', report([`unpack ${error instanceof Error ? error.message : 'failed'}`]));
    return true;
  }
}

function handleGitRoutes(ctx: Ctx): boolean {
  const forge = ctx.forge;
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(ctx.path);
  if (!match) return false;
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const action = match[3] as string;
  const repo = forge.getRepo(owner, name);
  if (!repo) {
    notFound(ctx.res);
    return true;
  }
  if (action === 'info/refs' && ctx.method === 'GET') {
    const service = ctx.query.get('service') ?? '';
    const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
    if (service === 'git-upload-pack') {
      sendRaw(ctx.res, 200, 'application/x-git-upload-pack-advertisement', isV2 ? advertiseUploadPackV2() : advertiseUploadPackV0(forge, repo));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(ctx.res, 200, 'application/x-git-receive-pack-advertisement', advertiseReceivePackV0(forge, repo));
      return true;
    }
    sendJson(ctx.res, 400, { message: `Invalid service: ${service}` });
    return true;
  }
  if (action === 'git-upload-pack' && ctx.method === 'POST') return handleUploadPack(ctx, repo);
  if (action === 'git-receive-pack' && ctx.method === 'POST') return handleReceivePack(ctx, repo);
  return false;
}

// ---------------------------------------------------------------- GraphQL: parser

interface GqlValue {
  readonly kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  readonly value?: unknown;
  readonly items?: readonly GqlValue[];
  readonly fields?: ReadonlyArray<readonly [string, GqlValue]>;
}

interface GqlField {
  readonly alias: string | null;
  readonly name: string;
  readonly args: ReadonlyArray<readonly [string, GqlValue]>;
  readonly selection: GqlSelection[] | null;
}

type GqlSelection =
  | { readonly kind: 'field'; readonly field: GqlField }
  | { readonly kind: 'fragment'; readonly name: string }
  | { readonly kind: 'inline'; readonly typeCondition: string | null; readonly selection: readonly GqlSelection[] };

interface GqlOperation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: ReadonlyArray<{ readonly name: string; readonly default: GqlValue | null }>;
  readonly selection: readonly GqlSelection[];
}

interface GqlDocument {
  readonly operations: readonly GqlOperation[];
  readonly fragments: Readonly<Record<string, { readonly typeCondition: string; readonly selection: readonly GqlSelection[] }>>;
}

interface GqlToken {
  readonly kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  readonly value: string;
}

function gqlTokenize(source: string): GqlToken[] {
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
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
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
      let isFloat = false;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  #tokens: GqlToken[];
  #pos = 0;
  constructor(tokens: GqlToken[]) {
    this.#tokens = tokens;
  }
  peek(): GqlToken | undefined {
    return this.#tokens[this.#pos];
  }
  next(): GqlToken {
    const token = this.#tokens[this.#pos];
    if (!token) throw new Error('Unexpected end of GraphQL document');
    this.#pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}" but got ${JSON.stringify(token.value)}`);
  }
  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected a name but got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) throw new Error(`Expected "${value}" but got ${JSON.stringify(token.value)}`);
    return token.value;
  }
  matchPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'punct' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }
  matchName(value: string): boolean {
    const token = this.peek();
    if (token && token.kind === 'name' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments: Record<string, { typeCondition: string; selection: GqlSelection[] }> = {};
    while (this.peek()) {
      if (this.matchPunct('{')) {
        operations.push({ type: 'query', name: null, variables: [], selection: this.parseSelectionSetBody() });
      } else if (this.matchName('query') || this.matchName('mutation')) {
        const type = this.#tokens[this.#pos - 1]?.value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next && next.kind === 'name') name = this.next().value;
        const variables = this.matchPunct('(') ? this.parseVariableDefinitions() : [];
        // Skip directives, if any.
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.parseDirective();
        this.expectPunct('{');
        operations.push({ type, name, variables, selection: this.parseSelectionSetBody() });
      } else if (this.matchName('fragment')) {
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.parseDirective();
        this.expectPunct('{');
        fragments[name] = { typeCondition, selection: this.parseSelectionSetBody() };
      } else {
        throw new Error(`Unexpected token ${JSON.stringify(this.peek()?.value)} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  parseDirective(): void {
    this.expectPunct('@');
    this.expectName();
    if (this.matchPunct('(')) this.parseArguments();
  }

  parseVariableDefinitions(): Array<{ name: string; default: GqlValue | null }> {
    const defs: Array<{ name: string; default: GqlValue | null }> = [];
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let def: GqlValue | null = null;
      if (this.matchPunct('=')) def = this.parseValue();
      defs.push({ name, default: def });
    }
    return defs;
  }

  parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  parseSelectionSetBody(): GqlSelection[] {
    const selections: GqlSelection[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  parseSelection(): GqlSelection {
    if (this.peek()?.kind === 'spread') {
      this.next();
      if (this.matchName('on')) {
        const typeCondition = this.expectName();
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.parseDirective();
        this.expectPunct('{');
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSetBody() };
      }
      const name = this.expectName();
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.parseDirective();
      return { kind: 'fragment', name };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.matchPunct('(') ? this.parseArguments() : [];
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') this.parseDirective();
    const selection = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? (this.next(), this.parseSelectionSetBody()) : null;
    return { kind: 'field', field: { alias, name, args, selection } };
  }

  parseArguments(): Array<readonly [string, GqlValue]> {
    const args: Array<readonly [string, GqlValue]> = [];
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push([name, this.parseValue()]);
    }
    return args;
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', value: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.matchPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<readonly [string, GqlValue]> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue()]);
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected token ${JSON.stringify(token.value)} in a GraphQL value`);
  }
}

function parseGraphQL(source: string): GqlDocument {
  return new GqlParser(gqlTokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- GraphQL: executor

type GqlNode = { readonly __typename: string; [key: string]: unknown };

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'labels', 'comments', 'url', 'closed', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'files'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL'];

function encodeCursor(index: number): string {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): number {
  const value = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isInteger(value) ? value : -1;
}

function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split < 0) return null;
    return { kind: text.slice(0, split), key: text.slice(split + 1) };
  } catch {
    return null;
  }
}

function userNode(): GqlNode {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, databaseId: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoNode(forge: Forge, repo: Repo): GqlNode {
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: globalId('Repository', repoKey(repo.owner, repo.name)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repoKey(repo.owner, repo.name),
    owner: userNode(),
    defaultBranchRef: defaultTip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    url: '',
    _forge: forge,
    _repo: repo,
  };
}

function issueNode(forge: Forge, repo: Repo, issue: Issue): GqlNode {
  return {
    __typename: 'Issue',
    id: globalId('Issue', `${repoKey(repo.owner, repo.name)}#${issue.number}`),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: userNode(),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closed: issue.state === 'closed',
    url: '',
    _forge: forge,
    _repo: repo,
    _issue: issue,
  };
}

function pullNode(forge: Forge, repo: Repo, pull: Pull): GqlNode {
  const conflicts = pull.state === 'open' ? forge.mergeConflicts(repo, pull.headRef, pull.baseRef) : null;
  return {
    __typename: 'PullRequest',
    id: globalId('PullRequest', `${repoKey(repo.owner, repo.name)}#${pull.number}`),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable: pull.state === 'open' ? (conflicts === null ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    author: userNode(),
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha },
    _forge: forge,
    _repo: repo,
    _pull: pull,
  };
}

function commentNode(forge: Forge, repo: Repo, issue: Issue, comment: IssueComment): GqlNode {
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', `${repoKey(repo.owner, repo.name)}#${issue.number}:${comment.id}`),
    databaseId: comment.id,
    body: comment.body,
    author: userNode(),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    _forge: forge,
    _repo: repo,
    _issue: issue,
    _comment: comment,
  };
}

function buildConnection<T extends GqlNode>(items: readonly T[], args: Record<string, unknown>, typeName: string, edgeName: string): GqlNode {
  const first = typeof args['first'] === 'number' ? args['first'] : 100;
  const after = typeof args['after'] === 'string' ? decodeCursor(args['after']) : -1;
  const start = Math.max(0, after + 1);
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length - 1;
  return {
    __typename: typeName,
    nodes: slice,
    edges: slice.map((node, index) => ({ __typename: edgeName, node, cursor: encodeCursor(start + index) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
      endCursor: slice.length > 0 ? encodeCursor(endIndex) : null,
    },
    totalCount: items.length,
  };
}

type GqlResolver = (parent: GqlNode, args: Record<string, unknown>, forge: Forge) => unknown;

const gqlResolvers: Record<string, Record<string, GqlResolver>> = {
  Query: {
    viewer: () => userNode(),
    repository: (_parent, args, forge) => {
      const owner = typeof args['owner'] === 'string' ? args['owner'] : '';
      const name = typeof args['name'] === 'string' ? args['name'] : '';
      const repo = forge.getRepo(owner, name);
      return repo ? repoNode(forge, repo) : null;
    },
    node: (_parent, args, forge) => {
      const id = typeof args['id'] === 'string' ? args['id'] : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const [owner, name] = decoded.key.split('/');
        const repo = owner && name ? forge.getRepo(owner, name) : undefined;
        return repo ? repoNode(forge, repo) : null;
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const [repoPart, numberPart] = decoded.key.split('#');
        const [owner, name] = (repoPart ?? '').split('/');
        const number = Number.parseInt(numberPart ?? '', 10);
        const repo = owner && name ? forge.getRepo(owner, name) : undefined;
        if (!repo || !Number.isInteger(number)) return null;
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue ? issueNode(forge, repo, issue) : null;
        }
        const pull = repo.pulls.get(number);
        return pull ? pullNode(forge, repo, pull) : null;
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = typeof args['name'] === 'string' ? args['name'] : '';
      if (name === 'Issue') return { __typename: '__Type', name, kind: 'OBJECT', fields: ISSUE_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
      if (name === 'PullRequest') return { __typename: '__Type', name, kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
      if (name === 'Repository') return { __typename: '__Type', name, kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: null };
      if (name === 'SearchType') return { __typename: '__Type', name, kind: 'ENUM', fields: null, enumValues: SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value })) };
      return null;
    },
    __schema: () => ({
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      types: ['Query', 'Mutation', 'Repository', 'Issue', 'PullRequest', 'User', 'SearchType'].map((name) => ({ __typename: '__Type', name })),
    }),
  },
  Repository: {
    issues: (parent, args) => {
      const forge = parent['_forge'] as Forge;
      const repo = parent['_repo'] as Repo;
      let list = [...repo.issues.values()];
      const states = Array.isArray(args['states']) ? (args['states'] as unknown[]) : null;
      if (states) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      list.sort((a, b) => a.seq - b.seq);
      const orderBy = asRecord(args['orderBy']);
      if (orderBy && strField(orderBy, 'field') === 'CREATED_AT' && strField(orderBy, 'direction') === 'DESC') list.reverse();
      return buildConnection(list.map((issue) => issueNode(forge, repo, issue)), args, 'IssueConnection', 'IssueEdge');
    },
    issue: (parent, args) => {
      const forge = parent['_forge'] as Forge;
      const repo = parent['_repo'] as Repo;
      const number = typeof args['number'] === 'number' ? args['number'] : -1;
      const issue = repo.issues.get(number);
      return issue ? issueNode(forge, repo, issue) : null;
    },
    pullRequests: (parent, args) => {
      const forge = parent['_forge'] as Forge;
      const repo = parent['_repo'] as Repo;
      let list = [...repo.pulls.values()];
      const states = Array.isArray(args['states']) ? (args['states'] as unknown[]) : null;
      if (states) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((pull) => wanted.has(pull.state === 'open' ? 'open' : pull.merged ? 'merged' : 'closed'));
      }
      list.sort((a, b) => a.seq - b.seq);
      return buildConnection(list.map((pull) => pullNode(forge, repo, pull)), args, 'PullRequestConnection', 'PullRequestEdge');
    },
    pullRequest: (parent, args) => {
      const forge = parent['_forge'] as Forge;
      const repo = parent['_repo'] as Repo;
      const number = typeof args['number'] === 'number' ? args['number'] : -1;
      const pull = repo.pulls.get(number);
      return pull ? pullNode(forge, repo, pull) : null;
    },
  },
  PullRequest: {
    files: (parent, args) => {
      const forge = parent['_forge'] as Forge;
      const repo = parent['_repo'] as Repo;
      const pull = parent['_pull'] as Pull;
      const headTip = forge.resolveRef(repo, pull.headRef);
      const baseTip = forge.resolveRef(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return buildConnection([], args, 'PullRequestFileConnection', 'PullRequestFileEdge');
      const base = forge.mergeBase(repo, headTip, baseTip);
      const baseMap = base === null ? new Map<string, string>() : forge.filesAt(repo, base);
      const headMap = forge.filesAt(repo, headTip);
      const files = forge.diffMaps(baseMap, headMap, repo).map((file) => ({
        __typename: 'PullRequestFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
      return buildConnection(files, args, 'PullRequestFileConnection', 'PullRequestFileEdge');
    },
  },
  Mutation: {
    createIssue: (_parent, args, forge) => {
      const input = asRecord(args['input']);
      if (!input) throw new Error('createIssue requires an input object');
      const repositoryId = strField(input, 'repositoryId');
      const decoded = decodeGlobalId(repositoryId);
      if (!decoded || decoded.kind !== 'Repository') throw new Error(`Unknown repository id: ${repositoryId}`);
      const [owner, name] = decoded.key.split('/');
      const repo = owner && name ? forge.getRepo(owner, name) : undefined;
      if (!repo) throw new Error(`Unknown repository id: ${repositoryId}`);
      const title = strField(input, 'title');
      if (title === '') throw new Error('title is required');
      const now = nowIso();
      const issue: Issue = {
        id: forge.nextIssueId++,
        number: repo.nextNumber++,
        title,
        body: strField(input, 'body'),
        state: 'open',
        labels: [],
        comments: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        seq: repo.seq++,
      };
      repo.issues.set(issue.number, issue);
      return { __typename: 'CreateIssuePayload', issue: issueNode(forge, repo, issue) };
    },
    closeIssue: (_parent, args, forge) => {
      const input = asRecord(args['input']);
      if (!input) throw new Error('closeIssue requires an input object');
      const issueId = strField(input, 'issueId');
      const decoded = decodeGlobalId(issueId);
      if (!decoded || decoded.kind !== 'Issue') throw new Error(`Unknown issue id: ${issueId}`);
      const [repoPart, numberPart] = decoded.key.split('#');
      const [owner, name] = (repoPart ?? '').split('/');
      const repo = owner && name ? forge.getRepo(owner, name) : undefined;
      const issue = repo?.issues.get(Number.parseInt(numberPart ?? '', 10));
      if (!issue || !repo) throw new Error(`Unknown issue id: ${issueId}`);
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      return { __typename: 'CloseIssuePayload', issue: issueNode(forge, repo, issue) };
    },
    createPullRequest: (_parent, args, forge) => {
      const input = asRecord(args['input']);
      if (!input) throw new Error('createPullRequest requires an input object');
      const repositoryId = strField(input, 'repositoryId');
      const decoded = decodeGlobalId(repositoryId);
      if (!decoded || decoded.kind !== 'Repository') throw new Error(`Unknown repository id: ${repositoryId}`);
      const [owner, name] = decoded.key.split('/');
      const repo = owner && name ? forge.getRepo(owner, name) : undefined;
      if (!repo) throw new Error(`Unknown repository id: ${repositoryId}`);
      const head = normalizeBranchRef(strField(input, 'headRefName'), owner ?? '');
      const base = normalizeBranchRef(strField(input, 'baseRefName'), owner ?? '');
      if (forge.resolveRef(repo, head) === null) throw new Error(`Invalid head branch: ${head}`);
      if (forge.resolveRef(repo, base) === null) throw new Error(`Invalid base branch: ${base}`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) throw new Error(`A pull request already exists for ${owner}:${head}`);
      }
      const now = nowIso();
      const pull: Pull = {
        id: forge.nextPullId++,
        number: repo.nextNumber++,
        title: strField(input, 'title'),
        body: strField(input, 'body'),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        seq: repo.seq++,
      };
      repo.pulls.set(pull.number, pull);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(forge, repo, pull) };
    },
    mergePullRequest: (_parent, args, forge) => {
      const input = asRecord(args['input']);
      if (!input) throw new Error('mergePullRequest requires an input object');
      const pullRequestId = strField(input, 'pullRequestId');
      const decoded = decodeGlobalId(pullRequestId);
      if (!decoded || decoded.kind !== 'PullRequest') throw new Error(`Unknown pull request id: ${pullRequestId}`);
      const [repoPart, numberPart] = decoded.key.split('#');
      const [owner, name] = (repoPart ?? '').split('/');
      const repo = owner && name ? forge.getRepo(owner, name) : undefined;
      const pull = repo?.pulls.get(Number.parseInt(numberPart ?? '', 10));
      if (!pull || !repo) throw new Error(`Unknown pull request id: ${pullRequestId}`);
      if (pull.state !== 'open') throw new Error('Pull request is not mergeable');
      const headTip = forge.resolveRef(repo, pull.headRef);
      const baseTip = forge.resolveRef(repo, pull.baseRef);
      if (headTip === null || baseTip === null) throw new Error('Pull request is not mergeable');
      const conflicts = forge.mergeConflicts(repo, pull.headRef, pull.baseRef);
      if (conflicts !== null) throw new Error(`Merge conflict in ${conflicts.join(', ')}`);
      const base = forge.mergeBase(repo, headTip, baseTip);
      const baseMap = base === null ? new Map<string, string>() : forge.filesAt(repo, base);
      const headMap = forge.filesAt(repo, headTip);
      const resultMap = forge.filesAt(repo, baseTip);
      for (const [path, oid] of headMap) if (baseMap.get(path) !== oid) resultMap.set(path, oid);
      for (const path of baseMap.keys()) if (!headMap.has(path) && resultMap.get(path) === baseMap.get(path)) resultMap.delete(path);
      const message = `Merge pull request #${pull.number} from ${owner}/${pull.headRef}\n\n${pull.title}`;
      const squashOid = forge.commitFiles(repo, pull.baseRef, resultMap, message, [forge.peel(repo, baseTip)]);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = squashOid;
      pull.updatedAt = nowIso();
      repo.updatedAt = nowIso();
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(forge, repo, pull) };
    },
    addComment: (_parent, args, forge) => {
      const input = asRecord(args['input']);
      if (!input) throw new Error('addComment requires an input object');
      const subjectId = strField(input, 'subjectId');
      const decoded = decodeGlobalId(subjectId);
      if (!decoded || decoded.kind !== 'Issue') throw new Error(`Unknown subject id: ${subjectId}`);
      const [repoPart, numberPart] = decoded.key.split('#');
      const [owner, name] = (repoPart ?? '').split('/');
      const repo = owner && name ? forge.getRepo(owner, name) : undefined;
      const issue = repo?.issues.get(Number.parseInt(numberPart ?? '', 10));
      if (!issue || !repo) throw new Error(`Unknown subject id: ${subjectId}`);
      const now = nowIso();
      const comment: IssueComment = { id: repo.nextCommentId++, body: strField(input, 'body'), userLogin: VIEWER.login, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node: commentNode(forge, repo, issue, comment), cursor: encodeCursor(issue.comments.length - 1) } };
    },
  },
};

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const name = value.value as string;
      return Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : null;
    }
    case 'list':
      return (value.items ?? []).map((item) => resolveGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields ?? []) out[key] = resolveGqlValue(item, variables);
      return out;
    }
    default:
      return value.value ?? null;
  }
}

function executeGqlSelection(
  forge: Forge,
  parent: GqlNode,
  typeName: string,
  selection: readonly GqlSelection[],
  variables: Record<string, unknown>,
  document: GqlDocument,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'fragment') {
      const fragment = document.fragments[item.name];
      if (fragment) Object.assign(out, executeGqlSelection(forge, parent, typeName, fragment.selection, variables, document, errors));
      continue;
    }
    if (item.kind === 'inline') {
      if (item.typeCondition === null || item.typeCondition === typeName) {
        Object.assign(out, executeGqlSelection(forge, parent, typeName, item.selection, variables, document, errors));
      }
      continue;
    }
    const field = item.field;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const resolver = gqlResolvers[typeName]?.[field.name];
    let value: unknown;
    if (resolver) {
      const args: Record<string, unknown> = {};
      for (const [key, argValue] of field.args) args[key] = resolveGqlValue(argValue, variables);
      try {
        value = resolver(parent, args, forge);
      } catch (error) {
        errors.push({ message: error instanceof Error ? error.message : 'Resolver failed' });
        out[responseKey] = null;
        continue;
      }
    } else if (Object.prototype.hasOwnProperty.call(parent, field.name)) {
      value = parent[field.name];
    } else {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = resolveGqlFieldValue(forge, value, field.selection, variables, document, errors);
  }
  return out;
}

function resolveGqlFieldValue(
  forge: Forge,
  value: unknown,
  selection: readonly GqlSelection[] | null,
  variables: Record<string, unknown>,
  document: GqlDocument,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (selection === null) return value;
  if (Array.isArray(value)) return value.map((item) => resolveGqlFieldValue(forge, item, selection, variables, document, errors));
  if (typeof value === 'object') {
    const node = value as GqlNode;
    if (typeof node['__typename'] === 'string') return executeGqlSelection(forge, node, node['__typename'] as string, selection, variables, document, errors);
    return value;
  }
  return value;
}

function executeGqlOperation(
  forge: Forge,
  document: GqlDocument,
  operation: GqlOperation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  const errors: Array<{ message: string }> = [];
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlNode = { __typename: rootType };
  const data = executeGqlSelection(forge, root, rootType, operation.selection, variables, document, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

function handleGraphQL(ctx: Ctx): boolean {
  const forge = ctx.forge;
  if (ctx.method !== 'POST') return false;
  const parsed = parseJsonBody(ctx.body);
  if (!parsed.ok) {
    badRequest(ctx.res, 'Problems parsing JSON');
    return true;
  }
  const requests = Array.isArray(parsed.value) ? (parsed.value as unknown[]) : [parsed.value];
  const responses = requests.map((request) => {
    const record = asRecord(request);
    if (!record || typeof record['query'] !== 'string') return { errors: [{ message: 'A query is required' }] };
    const variables = asRecord(record['variables']) ?? {};
    const operationName = typeof record['operationName'] === 'string' ? record['operationName'] : null;
    let document: GqlDocument;
    try {
      document = parseGraphQL(record['query'] as string);
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'Failed to parse the query' }] };
    }
    if (document.operations.length === 0) return { errors: [{ message: 'No operation found in the document' }] };
    let operation = document.operations[0] as GqlOperation;
    if (operationName !== null) {
      const named = document.operations.find((candidate) => candidate.name === operationName);
      if (!named) return { errors: [{ message: `Unknown operation named "${operationName}"` }] };
      operation = named;
    }
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const definition of operation.variables) {
      if (!Object.prototype.hasOwnProperty.call(mergedVariables, definition.name) && definition.default) {
        mergedVariables[definition.name] = resolveGqlValue(definition.default, variables);
      }
    }
    return executeGqlOperation(forge, document, operation, mergedVariables);
  });
  sendJson(ctx.res, 200, Array.isArray(parsed.value) ? responses : responses[0]);
  return true;
}

// ---------------------------------------------------------------- MCP (streamable HTTP, JSON-RPC 2.0)

const MCP_SERVER_NAME = 'github-core-clone';
const MCP_SERVER_VERSION = '1.0.0';
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: 'object'; readonly properties: Record<string, unknown>; readonly required: readonly string[] };
}

const MCP_TOOLS: readonly McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
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
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
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
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
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
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'The merge method.', enum: ['squash', 'merge', 'rebase'] },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpTextResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
}

function mcpErrorResult(message: string): Record<string, unknown> {
  const payload = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

/** Run one MCP tool; returns the tool result object (or throws for a JSON-RPC error). */
function runMcpTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return mcpErrorResult(`Missing required argument: ${required}`);
    }
  }
  const owner = typeof args['owner'] === 'string' ? args['owner'] : '';
  const repoName = typeof args['repo'] === 'string' ? args['repo'] : '';
  switch (name) {
    case 'create_repo': {
      const repoNameArg = args['name'] as string;
      if (forge.getRepo(VIEWER.login, repoNameArg)) return mcpErrorResult('name already exists on this account');
      const repo = forge.createRepo(repoNameArg, args['private'] === true, typeof args['description'] === 'string' ? args['description'] : '');
      return mcpTextResult(repoJson(repo));
    }
    case 'list_repos': {
      return mcpTextResult([...forge.repos.values()].sort((a, b) => a.id - b.id).map(repoJson));
    }
    case 'get_repo': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return mcpErrorResult('Not Found');
      return mcpTextResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return mcpErrorResult('Not Found');
      const labelNames = Array.isArray(args['labels']) ? (args['labels'] as unknown[]).filter((item): item is string => typeof item === 'string') : [];
      const labels: Label[] = [];
      for (const labelName of labelNames) {
        const label = repo.labels.get(labelName);
        if (!label) return mcpErrorResult(`Invalid label: ${labelName}`);
        labels.push(label);
      }
      const now = nowIso();
      const issue: Issue = {
        id: forge.nextIssueId++,
        number: repo.nextNumber++,
        title: args['title'] as string,
        body: typeof args['body'] === 'string' ? args['body'] : '',
        state: 'open',
        labels,
        comments: [],
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        seq: repo.seq++,
      };
      repo.issues.set(issue.number, issue);
      return mcpTextResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return mcpErrorResult('Not Found');
      const state = typeof args['state'] === 'string' ? args['state'] : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return mcpTextResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'get_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return mcpErrorResult('Not Found');
      const issue = repo.issues.get(Number(args['issue_number']));
      if (!issue) return mcpErrorResult('Not Found');
      return mcpTextResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return mcpErrorResult('Not Found');
      const head = normalizeBranchRef(args['head'] as string, owner);
      const base = normalizeBranchRef(args['base'] as string, owner);
      if (forge.resolveRef(repo, head) === null) return mcpErrorResult(`Invalid head branch: ${head}`);
      if (forge.resolveRef(repo, base) === null) return mcpErrorResult(`Invalid base branch: ${base}`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) return mcpErrorResult(`A pull request already exists for ${owner}:${head}`);
      }
      const now = nowIso();
      const pull: Pull = {
        id: forge.nextPullId++,
        number: repo.nextNumber++,
        title: args['title'] as string,
        body: typeof args['body'] === 'string' ? args['body'] : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        userLogin: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        seq: repo.seq++,
      };
      repo.pulls.set(pull.number, pull);
      return mcpTextResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return mcpErrorResult('Not Found');
      const pull = repo.pulls.get(Number(args['pull_number']));
      if (!pull) return mcpErrorResult('Not Found');
      if (pull.state !== 'open') return mcpErrorResult('Pull request is not mergeable');
      const headTip = forge.resolveRef(repo, pull.headRef);
      const baseTip = forge.resolveRef(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return mcpErrorResult('Pull request is not mergeable');
      const conflicts = forge.mergeConflicts(repo, pull.headRef, pull.baseRef);
      if (conflicts !== null) return mcpErrorResult(`Merge conflict in ${conflicts.join(', ')}`);
      const base = forge.mergeBase(repo, headTip, baseTip);
      const baseMap = base === null ? new Map<string, string>() : forge.filesAt(repo, base);
      const headMap = forge.filesAt(repo, headTip);
      const resultMap = forge.filesAt(repo, baseTip);
      for (const [path, oid] of headMap) if (baseMap.get(path) !== oid) resultMap.set(path, oid);
      for (const path of baseMap.keys()) if (!headMap.has(path) && resultMap.get(path) === baseMap.get(path)) resultMap.delete(path);
      const message = `Merge pull request #${pull.number} from ${owner}/${pull.headRef}\n\n${pull.title}`;
      const squashOid = forge.commitFiles(repo, pull.baseRef, resultMap, message, [forge.peel(repo, baseTip)]);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = squashOid;
      pull.updatedAt = nowIso();
      repo.updatedAt = nowIso();
      return mcpTextResult({ merged: true, sha: squashOid, message: 'Pull Request successfully merged' });
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

function handleMcp(ctx: Ctx): boolean {
  const forge = ctx.forge;
  if (ctx.method !== 'POST') return false;
  const raw = ctx.body.toString('utf8');
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    request = parsed as Record<string, unknown>;
  } catch {
    const idMatch = /"id"\s*:\s*("[^"]*"|\d+)/.exec(raw);
    const id = idMatch ? JSON.parse(idMatch[1] as string) as unknown : null;
    sendJson(ctx.res, 400, { jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const id = request['id'];
  const method = typeof request['method'] === 'string' ? request['method'] : '';
  const params = asRecord(request['params']) ?? {};

  // Notifications carry no id: answer 202 with an empty body.
  if (id === undefined || id === null) {
    if (method.startsWith('notifications/')) {
      sendEmpty(ctx.res, 202);
      return true;
    }
    sendJson(ctx.res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }

  const reply = (result: unknown): void => {
    sendJson(ctx.res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(ctx.res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    reply({
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2025-03-26';
    reply({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
    return true;
  }
  if (method === 'ping') {
    reply({});
    return true;
  }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const toolName = typeof params['name'] === 'string' ? params['name'] : '';
    const toolArgs = asRecord(params['arguments']) ?? {};
    try {
      reply(runMcpTool(forge, toolName, toolArgs));
    } catch (error) {
      const code = (error as { code?: number })?.code ?? -32602;
      replyError(code, error instanceof Error ? error.message : 'Tool call failed');
    }
    return true;
  }
  replyError(-32601, `Method not found: ${method}`);
  return true;
}

// ---------------------------------------------------------------- the app

/** Build the forge server: one in-memory store, one process, stdlib only. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      let path = url.pathname;
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      const ctx: Ctx = {
        req,
        res,
        method: req.method ?? 'GET',
        path,
        query: url.searchParams,
        segments: path.split('/').filter((part) => part !== ''),
        body: Buffer.alloc(0),
        json: undefined,
        jsonOk: true,
        forge,
      };
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      ctx.body = await readBody(req);
      // Git smart HTTP is public (clone of a public repo needs no token).
      if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
        if (!handleGitRoutes(ctx)) notFound(res);
        return;
      }
      if (!authorized(req)) {
        unauthorized(res);
        return;
      }
      if (ctx.method !== 'GET' && path.startsWith('/api/')) {
        const parsed = parseJsonBody(ctx.body);
        if (!parsed.ok) {
          badRequest(res, 'Problems parsing JSON');
          return;
        }
        ctx.json = parsed.value;
        ctx.jsonOk = parsed.ok;
      }
      if (path === '/api/graphql') {
        if (!handleGraphQL(ctx)) notFound(res);
        return;
      }
      if (path === '/mcp') {
        if (!handleMcp(ctx)) notFound(res);
        return;
      }
      if (handleRepoRoutes(ctx)) return;
      if (handleCollabRoutes(ctx)) return;
      notFound(res);
    } catch (error) {
      try {
        sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });
  return server;
}
