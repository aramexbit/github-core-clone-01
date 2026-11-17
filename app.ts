// github-core-clone-01 v3 — standalone GitHub-compatible git forge.
// Written fresh from the competition spec (RULES.txt + kit env behaviour).
// Perf focus: pack/ls-refs/response caching, Map-based stores, lean hot paths.
// Node 22+, standard library only.

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

// ---- v5 Step-0 profiler: hrtime counters, env-gated, zero cost when off ----
// Enabled only with MF_PROFILE=1. Snapshots append JSON lines to
// MF_PROFILE_OUT every 2s + once at exit (process.on("exit")). When off,
// every probe is a single false boolean check; no hrtime call executes.
// Rows: { ms, n } per section; counts (ns: 0) are pure event counters.
const PROF_ON = process.env.MF_PROFILE === "1";
const PROF_OUT = process.env.MF_PROFILE_OUT ?? "";
const profT = new Map<string, { ns: number; n: number }>();
function profAdd(name: string, ns: number): void {
  const e = profT.get(name);
  if (e) { e.ns += ns; e.n += 1; } else profT.set(name, { ns, n: 1 });
}
function profInc(name: string, d = 1): void {
  const e = profT.get(name);
  if (e) { e.n += d; } else profT.set(name, { ns: 0, n: d });
}
const profStartMs = Date.now();
const profCpuStart = process.cpuUsage();
function profSnap(reason: string): void {
  if (!PROF_ON || !PROF_OUT) return;
  const rows: Record<string, { ms: number; n: number }> = {};
  for (const [k, v] of profT) rows[k] = { ms: Math.round(v.ns / 1e4) / 100, n: v.n };
  const cpu = process.cpuUsage(profCpuStart);
  const cpuMs = { user: Math.round(cpu.user / 100) / 10, system: Math.round(cpu.system / 100) / 10 };
  try {
    writeFileSync(PROF_OUT, JSON.stringify({ tMs: Date.now() - profStartMs, reason, cpuMs, rows }) + "\n", { flag: "a" });
  } catch { /* profiling must never break the forge */ }
}
if (PROF_ON) {
  process.on("exit", () => profSnap("exit"));
  setInterval(() => profSnap("tick"), 500).unref();
}

export const ZERO_OID = "0000000000000000000000000000000000000000";
export const VIEWER_LOGIN = "adaiversen"; // scenario viewer, fixed by the kit's public seed
export const VIEWER_ID = 1000;
export const VIEWER_NAME = "ada iversen";
export const VIEWER_EMAIL = "adaiversen@example.invalid";
export const AGENT_NAME = "github-core-clone/3.0.0";
export const DEFAULT_BRANCH = "main";

// ---------------------------------------------------------------- utils

export function sha1Hex(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

export function hashObject(type: string, data: Buffer): string {
  const h = createHash("sha1");
  h.update(`${type} ${data.length}\0`, "utf8");
  h.update(data);
  return h.digest("hex");
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isOid(v: string): boolean {
  return HEX40.test(v);
}

export function b64encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
export function b64decode(b64: string): string {
  return Buffer.from(b64.replace(/[\r\n\t ]+/g, ""), "base64").toString("utf8");
}
export function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

// ------------------------------------------------------------ pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, "0"), 0, 4, "ascii");
  return Buffer.concat([head, data]);
}
export const PKT_FLUSH = Buffer.from("0000", "ascii");
export const PKT_DELIM = Buffer.from("0001", "ascii");

/** One sideband pkt-line for a slice of the pack: a single preallocated
 *  buffer (4-byte hex length + band byte + raw bytes), no intermediate
 *  concats per 65 KB chunk. */
function pktLineBanded(pack: Buffer, off: number, len: number): Buffer {
  const pkt = Buffer.allocUnsafe(4 + 1 + len);
  pkt.write((len + 5).toString(16).padStart(4, "0"), 0, 4, "ascii");
  pkt[4] = 1;
  pack.copy(pkt, 5, off, off + len);
  return pkt;
}

export interface PktPacket {
  kind: "flush" | "delim" | "response-end" | "data";
  payload: Buffer | null;
}

/** Parse pkt-lines from the start of buf. Returns packets and the offset
 *  just past the first flush (or buf.length). Throws on malformed headers. */
export function parsePktLines(buf: Buffer): { packets: PktPacket[]; restOffset: number } {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    }
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: "flush", payload: null });
      return { packets, restOffset: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: "delim", payload: null });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: "response-end", payload: null });
      off += 4;
      continue;
    }
    if (len === 3 || len > 65520) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error("truncated pkt-line");
    packets.push({ kind: "data", payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== buf.length) throw new Error("truncated pkt-line header");
  return { packets, restOffset: off };
}

export function pktLinesToText(packets: PktPacket[]): string[] {
  const out: string[] = [];
  for (const p of packets) {
    if (p.kind === "data" && p.payload) out.push(p.payload.toString("utf8"));
  }
  return out;
}

// ------------------------------------------------------- git objects

export interface GitObject {
  type: "commit" | "tree" | "blob" | "tag";
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(32, off);
    if (sp < 0) throw new Error("tree entry has no mode separator");
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error("tree entry truncated");
    entries.push({
      mode: data.subarray(off, sp).toString("ascii"),
      name: data.subarray(sp + 1, nul).toString("utf8"),
      oid: data.subarray(nul + 1, nul + 21).toString("hex"),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === "40000" ? `${a.name}/` : a.name, "utf8");
  const r = Buffer.from(b.mode === "40000" ? `${b.name}/` : b.name, "utf8");
  return Buffer.compare(l, r);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitParts {
  const blank = data.indexOf("\n\n");
  const headEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? "" : data.subarray(blank + 2).toString("utf8");
  let tree = "";
  const parents: string[] = [];
  let author = "";
  let committer = "";
  // Parse the header straight from the buffer: no whole-head string, no split.
  let off = 0;
  while (off < headEnd) {
    const nl = data.indexOf(10, off);
    const lineEnd = nl < 0 || nl > headEnd ? headEnd : nl;
    const sp = data.indexOf(32, off);
    if (sp < 0 || sp >= lineEnd) {
      off = lineEnd + 1;
      continue;
    }
    const key = data.subarray(off, sp).toString("ascii");
    const val = data.subarray(sp + 1, lineEnd).toString("utf8");
    if (key === "tree") tree = val;
    else if (key === "parent") parents.push(val);
    else if (key === "author") author = val;
    else if (key === "committer") committer = val;
    off = lineEnd + 1;
  }
  return { tree, parents, author, committer, message };
}

/** Parsed commit headers, cached per repo: commits are immutable, and the
 *  push workload's ancestry walk would otherwise re-parse every commit on
 *  every push (O(N^2) parses over a 200-push chain). */
export function commitParts(repo: Repo, oid: string): CommitParts | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== "commit") return null;
  const parts = parseCommit(obj.data);
  repo.commitCache.set(oid, parts);
  return parts;
}

export function buildCommit(fields: {
  tree: string;
  parents: string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}): Buffer {
  const ts = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${ts} +0000`;
  const author = fields.author ?? who;
  const committer = fields.committer ?? who;
  let out = `tree ${fields.tree}\n`;
  for (const p of fields.parents) out += `parent ${p}\n`;
  out += `author ${author}\ncommitter ${committer}\n\n${fields.message}`;
  return Buffer.from(out, "utf8");
}

export interface TagParts {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagParts {
  const blank = data.indexOf("\n\n");
  const headEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headEnd).toString("utf8").split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: headers.get("object") ?? "",
    type: headers.get("type") ?? "",
    tag: headers.get("tag") ?? "",
    tagger: headers.get("tagger") ?? "",
    message: blank < 0 ? "" : data.subarray(blank + 2).toString("utf8"),
  };
}

// ------------------------------------------------------------ packs

const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, string> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

function writePackObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 15);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 128);
    first = remaining & 127;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a pack (v2, no deltas) from objects. Deterministic order by oid. */
export function writePack(objects: GitObject[] | Map<string, GitObject>): Buffer {
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  const list: { oid: string; type: string; data: Buffer }[] = [];
  if (objects instanceof Map) {
    for (const [oid, o] of objects) list.push({ oid, type: o.type, data: o.data });
  } else {
    for (const o of objects) list.push({ oid: hashObject(o.type, o.data), type: o.type, data: o.data });
  }
  list.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write("PACK", 0, 4, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  let defNs = 0;
  for (const o of list) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    if (PROF_ON) {
      const d0 = process.hrtime.bigint();
      parts.push(deflateSync(o.data));
      defNs += Number(process.hrtime.bigint() - d0);
    } else {
      parts.push(deflateSync(o.data));
    }
  }
  const body = Buffer.concat(parts);
  const out = Buffer.concat([body, createHash("sha1").update(body).digest()]);
  if (PROF_ON) {
    profAdd("pack.writePack", Number(process.hrtime.bigint() - t0));
    profAdd("pack.deflate", defNs);
    profInc("pack.deflateObjs", list.length);
  }
  return out;
}

function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error("pack entry has no size header");
  let byte = buf[start];
  const first = byte;
  let size = byte & 15;
  let shift = 4;
  let off = start + 1;
  while (byte & 128) {
    if (off >= buf.length) throw new Error("pack entry size varint truncated");
    byte = buf[off++];
    size += (byte & 127) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error("pack size varint too long");
  }
  return { size, next: off, first };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error("ofs-delta has no base offset");
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 127;
  while (byte & 128) {
    if (off >= buf.length) throw new Error("ofs-delta base offset truncated");
    byte = buf[off++];
    value = (value + 1) * 128 + (byte & 127);
  }
  return { baseOffset: value, next: off };
}

function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (e) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(e as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error("delta size varint truncated");
      const byte = delta[off++];
      value += (byte & 127) * 2 ** shift;
      shift += 7;
      if (!(byte & 128)) break;
      if (shift > 63) throw new Error("delta size varint too long");
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 128) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error("delta copy offset truncated");
          copyOffset += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error("delta copy size truncated");
          copySize += delta[off++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 65536;
      if (copyOffset + copySize > base.length) throw new Error("delta copy out of base");
      if (written + copySize > targetSize) throw new Error("delta writes past target");
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 127;
      if (off + literal > delta.length) throw new Error("delta insert truncated");
      if (written + literal > targetSize) throw new Error("delta writes past target");
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error("delta opcode 0 invalid");
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  checksumOk: boolean;
}

/** Parse a pack (v2/v3, ofs/ref deltas). resolveBase supplies objects the
 *  pack deltas against that are not in the pack (used for thin packs). */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): ReadPackResult {
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  let profInfNs = 0;
  let profDeltaNs = 0;
  let profDeltaN = 0;
  let profHashNs = 0;
  const buf = pack;
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.subarray(0, 4).toString("ascii") !== "PACK") throw new Error("pack does not start with PACK");
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString("hex");
  const computedTrailer = createHash("sha1").update(buf.subarray(0, trailerStart)).digest("hex");
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) throw new Error("pack trailer checksum mismatch");
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i++) {
    const entryOffset = offset;
    const header = readVarintSize(buf, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 7;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buf, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error("ref-delta base id truncated");
      entry.baseOid = buf.subarray(offset, offset + 20).toString("hex");
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${typeCode}`);
    }
    let inflated: { data: Buffer; next: number };
    if (PROF_ON) {
      const i0 = process.hrtime.bigint();
      inflated = inflateAt(buf, offset, trailerStart);
      profInfNs += Number(process.hrtime.bigint() - i0);
    } else {
      inflated = inflateAt(buf, offset, trailerStart);
    }
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before trailer`);
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;
  const resolve = (entry: RawEntry): { type: string; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: string; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} not in pack`);
      const base = resolve(baseEntry);
      type = base.type;
      if (PROF_ON) {
        const d0 = process.hrtime.bigint();
        data = applyDelta(base.data, entry.data);
        profDeltaNs += Number(process.hrtime.bigint() - d0);
        profDeltaN += 1;
      } else {
        data = applyDelta(base.data, entry.data);
      }
    } else if (entry.typeCode === 7) {
      const inPack = resolvedByOid.get(entry.baseOid!);
      if (inPack) {
        const base = resolve(inPack);
        type = base.type;
        if (PROF_ON) {
          const d0 = process.hrtime.bigint();
          data = applyDelta(base.data, entry.data);
          profDeltaNs += Number(process.hrtime.bigint() - d0);
          profDeltaN += 1;
        } else {
          data = applyDelta(base.data, entry.data);
        }
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} neither in pack nor supplied`);
        type = external.type;
        if (PROF_ON) {
          const d0 = process.hrtime.bigint();
          data = applyDelta(external.data, entry.data);
          profDeltaNs += Number(process.hrtime.bigint() - d0);
          profDeltaN += 1;
        } else {
          data = applyDelta(external.data, entry.data);
        }
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    let oid: string;
    if (PROF_ON) {
      const h0 = process.hrtime.bigint();
      oid = hashObject(type, data);
      profHashNs += Number(process.hrtime.bigint() - h0);
    } else {
      oid = hashObject(type, data);
    }
    const out = { type, data, oid };
    (entry as unknown as { _r?: unknown })._r = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount++;
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type as GitObject["type"], data: r.data });
  }
  if (PROF_ON) {
    profAdd("pack.readPack", Number(process.hrtime.bigint() - t0));
    profAdd("pack.inflate", profInfNs);
    profAdd("pack.applyDelta", profDeltaNs);
    profInc("pack.deltaOps", profDeltaN);
    profAdd("pack.hash", profHashNs);
    profInc("pack.readPackObjs", objects.size);
  }
  return { objects, deltaCount, checksumOk };
}

// ------------------------------------------------------------ store

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  packCache: Map<string, Buffer>;
  lsRefsCache: Buffer | null;
  advCache: Map<string, Buffer>;
  issueJson: Map<number, Buffer>;
  commitCache: Map<string, CommitParts>;
}

export interface ForgeState {
  token: string;
  authHeader: string;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextCommentId: number;
  requestSeq: number;
  globalSeq: number;
}

export function createState(token: string): ForgeState {
  return {
    token,
    authHeader: `Bearer ${token}`,
    repos: new Map(),
    nextRepoId: 1,
    nextCommentId: 1,
    requestSeq: 0,
    globalSeq: 0,
  };
}

export function nextSeq(state: ForgeState): number {
  return ++state.globalSeq;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(state: ForgeState, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return state.repos.get(repoKey(owner, name));
}

export function createRepoRecord(
  state: ForgeState,
  name: string,
  description: string,
  priv: boolean,
): Repo {
  const repo: Repo = {
    id: state.nextRepoId++,
    name,
    owner: VIEWER_LOGIN,
    description: description ?? "",
    priv: !!priv,
    defaultBranch: DEFAULT_BRANCH,
    createdSeq: nextSeq(state),
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    labels: new Map(),
    comments: new Map(),
    packCache: new Map(),
    lsRefsCache: null,
    advCache: new Map(),
    issueJson: new Map(),
    commitCache: new Map(),
  };
  state.repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

export function repoFullName(repo: Repo): string {
  return `${repo.owner}/${repo.name}`;
}

export function globalId(kind: string, dbId: number): string {
  return b64encode(`${kind}:${dbId}`);
}

export function defaultBranchRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

export function resolveRef(repo: Repo, refname: string): string | undefined {
  if (refname === "HEAD") return repo.refs.get(defaultBranchRefName(repo));
  return repo.refs.get(refname);
}

export function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === "commit") return cur;
    if (obj.type === "tag") {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

export function storeObject(repo: Repo, type: GitObject["type"], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function createCommitRecord(
  repo: Repo,
  tree: string,
  parents: string[],
  message: string,
): string {
  const data = buildCommit({ tree, parents, message });
  return storeObject(repo, "commit", data);
}

export function invalidateRepoCache(repo: Repo): void {
  repo.packCache.clear();
  repo.lsRefsCache = null;
  repo.advCache.clear();
}

/** Parsed tree entries, cached on the object itself: trees are immutable,
 *  and fetch/clone walks would otherwise re-parse every tree per request. */
export function treeEntriesOfObj(obj: GitObject): TreeEntry[] {
  const cached = (obj as unknown as { _tree?: TreeEntry[] })._tree;
  if (cached) return cached;
  const entries = parseTree(obj.data);
  (obj as unknown as { _tree?: TreeEntry[] })._tree = entries;
  return entries;
}

/** One tree entry by name, via a per-tree Map built once (lookupPath walks
 *  one segment at a time and must not scan the entry list per segment). */
export function treeEntryByName(obj: GitObject, name: string): TreeEntry | undefined {
  let byName = (obj as unknown as { _treeByName?: Map<string, TreeEntry> })._treeByName;
  if (!byName) {
    byName = new Map<string, TreeEntry>();
    for (const e of treeEntriesOfObj(obj)) byName.set(e.name, e);
    (obj as unknown as { _treeByName?: Map<string, TreeEntry> })._treeByName = byName;
  }
  return byName.get(name);
}

export function treeEntriesOf(repo: Repo, treeOid: string): TreeEntry[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== "tree") return [];
  return treeEntriesOfObj(obj);
}

/** Flatten a tree into path -> {mode, oid} (recursive). */
export function flattenTree(
  repo: Repo,
  treeOid: string,
  prefix: string,
  out: Map<string, { mode: string; oid: string }>,
): void {
  for (const e of treeEntriesOf(repo, treeOid)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === "40000") {
      flattenTree(repo, e.oid, path, out);
    } else {
      out.set(path, { mode: e.mode, oid: e.oid });
    }
  }
}

/** Walk to the blob/tree at a path. Returns {mode, oid} or null. */
export function lookupPath(
  repo: Repo,
  treeOid: string,
  segments: string[],
): { mode: string; oid: string } | null {
  let cur = treeOid;
  for (let i = 0; i < segments.length; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== "tree") return null;
    const e = treeEntryByName(obj, segments[i]);
    if (!e) return null;
    if (i === segments.length - 1) return { mode: e.mode, oid: e.oid };
    if (e.mode !== "40000") return null;
    cur = e.oid;
  }
  return null;
}

export function readBlobText(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== "blob") return null;
  return obj.data.toString("utf8");
}

/** Build a new tree with `blobOid` at `segments` (replacing/creating
 *  intermediate trees). Returns the new root tree oid. */
export function buildTreeWithPath(
  repo: Repo,
  baseTreeOid: string | null,
  segments: string[],
  blobOid: string,
  blobMode = "100644",
): string {
  if (segments.length === 0) return baseTreeOid ?? storeObject(repo, "tree", buildTree([]));
  const [head, ...rest] = segments;
  const entries = baseTreeOid ? treeEntriesOf(repo, baseTreeOid) : [];
  const next: TreeEntry[] = [];
  let found = false;
  for (const e of entries) {
    if (e.name !== head) {
      next.push(e);
      continue;
    }
    found = true;
    if (rest.length === 0) {
      next.push({ mode: blobMode, name: head, oid: blobOid });
    } else if (e.mode === "40000") {
      next.push({ mode: "40000", name: head, oid: buildTreeWithPath(repo, e.oid, rest, blobOid, blobMode) });
    } else {
      next.push({ mode: "40000", name: head, oid: buildTreeWithPath(repo, null, rest, blobOid, blobMode) });
    }
  }
  if (!found) {
    if (rest.length === 0) {
      next.push({ mode: blobMode, name: head, oid: blobOid });
    } else {
      next.push({ mode: "40000", name: head, oid: buildTreeWithPath(repo, null, rest, blobOid, blobMode) });
    }
  }
  return storeObject(repo, "tree", buildTree(next));
}

/** Build a new tree with the entry at `segments` removed. */
export function buildTreeWithoutPath(
  repo: Repo,
  baseTreeOid: string,
  segments: string[],
): string | null {
  const [head, ...rest] = segments;
  const entries = treeEntriesOf(repo, baseTreeOid);
  const next: TreeEntry[] = [];
  let found = false;
  for (const e of entries) {
    if (e.name !== head) {
      next.push(e);
      continue;
    }
    found = true;
    if (rest.length === 0) continue; // drop it
    if (e.mode !== "40000") continue;
    const child = buildTreeWithoutPath(repo, e.oid, rest);
    if (child !== null) next.push({ mode: "40000", name: head, oid: child });
  }
  if (!found) return baseTreeOid;
  if (next.length === 0) return null;
  return storeObject(repo, "tree", buildTree(next));
}

/** First-parent chain from a commit tip, newest first. */
export function commitChain(repo: Repo, tipOid: string, limit: number): { oid: string; commit: CommitParts }[] {
  const out: { oid: string; commit: CommitParts }[] = [];
  let cur: string | undefined = tipOid;
  const seen = new Set<string>();
  while (cur && out.length < limit && !seen.has(cur)) {
    seen.add(cur);
    const parts = commitParts(repo, cur);
    if (!parts) break;
    out.push({ oid: cur, commit: parts });
    cur = parts.parents[0];
  }
  return out;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  // Fast path: a linear first-parent chain (the push workload's shape).
  // Walk first parents only — O(depth) cached lookups, no queue, no re-parse.
  let cur: string | undefined = desc;
  const seenFirst = new Set<string>();
  while (cur && !seenFirst.has(cur)) {
    seenFirst.add(cur);
    const parts = commitParts(repo, cur);
    if (!parts) break;
    if (parts.parents.length === 0) break;
    const first = parts.parents[0];
    if (first === anc) return true;
    cur = first;
    if (seenFirst.size > 100000) break;
  }
  // General DAG: BFS with an index-pointer queue (queue.shift() is O(N) in V8).
  const queue: string[] = [desc];
  const seen = new Set<string>([desc]);
  let head = 0;
  while (head < queue.length) {
    const curOid = queue[head++]!;
    const parts = commitParts(repo, curOid);
    if (!parts) continue;
    for (const p of parts.parents) {
      if (p === anc) return true;
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
    if (seen.size > 100000) return false;
  }
  return false;
}

export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const queueA: string[] = [a];
  const seenA = new Set<string>([a]);
  let headA = 0;
  while (headA < queueA.length) {
    const cur = queueA[headA++]!;
    ancestors.add(cur);
    const parts = commitParts(repo, cur);
    if (!parts) continue;
    for (const p of parts.parents) {
      if (!seenA.has(p)) {
        seenA.add(p);
        queueA.push(p);
      }
    }
    if (ancestors.size > 100000) break;
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>([b]);
  let headB = 0;
  while (headB < queueB.length) {
    const cur = queueB[headB++]!;
    if (ancestors.has(cur)) return cur;
    const parts = commitParts(repo, cur);
    if (!parts) continue;
    for (const p of parts.parents) {
      if (!seenB.has(p)) {
        seenB.add(p);
        queueB.push(p);
      }
    }
    if (seenB.size > 100000) break;
  }
  return null;
}

// ------------------------------------------------------------ line diff

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** LCS-based line diff (DP capped; falls back to full counts for big files). */
export function diffLines(baseText: string, headText: string): { additions: number; deletions: number } {
  const a = baseText.length === 0 ? [] : baseText.split("\n");
  const b = headText.length === 0 ? [] : headText.split("\n");
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();
  if (a.length > 400 || b.length > 400) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) dp.push(new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

export interface FileDiff {
  filename: string;
  status: "added" | "modified" | "removed" | "changed";
  additions: number;
  deletions: number;
  changes: number;
}

export function diffTrees(
  repo: Repo,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileDiff[] {
  const baseMap = new Map<string, { mode: string; oid: string }>();
  const headMap = new Map<string, { mode: string; oid: string }>();
  if (baseTreeOid) flattenTree(repo, baseTreeOid, "", baseMap);
  if (headTreeOid) flattenTree(repo, headTreeOid, "", headMap);
  const out: FileDiff[] = [];
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b && !h) {
      const deletions = countLines(readBlobText(repo, b.oid) ?? "");
      out.push({ filename: path, status: "removed", additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = countLines(readBlobText(repo, h.oid) ?? "");
      out.push({ filename: path, status: "added", additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const d = diffLines(readBlobText(repo, b.oid) ?? "", readBlobText(repo, h.oid) ?? "");
      out.push({ filename: path, status: "modified", additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

// ------------------------------------------------------ fetch send-set

export interface SendSet {
  send: Map<string, GitObject>;
  shallowOut: string[];
  unshallowOut: string[];
}

/** Compute the objects to send for a fetch. wants/haves/shallow are oids
 *  as sent by the client; depth is null for a full fetch. */
export function computeSendSet(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): SendSet {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallowBoundaries);
  const send = new Map<string, GitObject>();
  const toSendCommits: string[] = [];
  const visitedCommits = new Set<string>();

  const addObject = (oid: string): void => {
    const obj = repo.objects.get(oid);
    if (obj && !send.has(oid)) send.set(oid, obj);
  };
  const addTreeClosure = (treeOid: string, seenTrees: Set<string>): void => {
    const stack: string[] = [treeOid];
    while (stack.length) {
      const t = stack.pop()!;
      if (seenTrees.has(t)) continue;
      seenTrees.add(t);
      addObject(t);
      const obj = repo.objects.get(t);
      if (!obj || obj.type !== "tree") continue;
      for (const e of treeEntriesOfObj(obj)) {
        if (e.mode === "40000") stack.push(e.oid);
        else addObject(e.oid);
      }
    }
  };

  // Expand wants (tags peel to their commit; the tag object itself is sent).
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === "tag") {
      addObject(want);
      const target = peelToCommit(repo, want);
      if (target) wantCommits.push(target);
    } else if (obj.type === "commit") {
      wantCommits.push(want);
    } else {
      addObject(want);
    }
  }

  // Walk commits. With a depth limit the walk is bounded by depth and
  // does not stop at haves/shallow (a deepen can pass through a have).
  // Without depth the walk stops at haves and shallow boundaries.
  const stack: { oid: string; depth: number }[] = wantCommits.map((oid) => ({ oid, depth: 1 }));
  while (stack.length) {
    const { oid, depth: d } = stack.pop()!;
    if (visitedCommits.has(oid)) continue;
    visitedCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== "commit") continue;
    if (depth !== null && d > depth) continue;
    if (depth === null && (haveSet.has(oid) || shallowSet.has(oid))) continue;
    toSendCommits.push(oid);
    const parts = commitParts(repo, oid);
    if (!parts) continue;
    for (const p of parts.parents) {
      stack.push({ oid: p, depth: d + 1 });
    }
  }

  const treeSeen = new Set<string>();
  for (const oid of toSendCommits) {
    addObject(oid);
    const parts = commitParts(repo, oid);
    if (!parts) continue;
    addTreeClosure(parts.tree, treeSeen);
  }

  // Subtract what the client already holds (haves + shallow boundaries).
  const held = new Set<string>();
  const heldTreeSeen = new Set<string>();
  const collectHeld = (oid: string): void => {
    const peeled = peelToCommit(repo, oid);
    if (!peeled) return;
    if (held.has(peeled)) return;
    held.add(peeled);
    const obj = repo.objects.get(peeled);
    if (!obj || obj.type !== "commit") return;
    const parts = commitParts(repo, peeled);
    if (!parts) return;
    const stack2: string[] = [parts.tree];
    while (stack2.length) {
      const t = stack2.pop()!;
      if (heldTreeSeen.has(t)) continue;
      heldTreeSeen.add(t);
      held.add(t);
      const tObj = repo.objects.get(t);
      if (!tObj || tObj.type !== "tree") continue;
      for (const e of treeEntriesOfObj(tObj)) {
        if (e.mode === "40000") stack2.push(e.oid);
        else held.add(e.oid);
      }
    }
  };
  for (const h of haves) collectHeld(h);
  for (const s of shallowBoundaries) collectHeld(s);
  for (const oid of held) send.delete(oid);

  // Shallow bookkeeping (only when a depth was requested).
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== null) {
    const sentSet = new Set(toSendCommits);
    for (const oid of toSendCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== "commit") continue;
      const parts = commitParts(repo, oid);
      if (!parts) continue;
      const hasParent = parts.parents.length > 0;
      const allParentsSent = parts.parents.every((p) => sentSet.has(p));
      if (hasParent && !allParentsSent) shallowOut.push(oid);
      if (shallowSet.has(oid) && hasParent && allParentsSent) unshallowOut.push(oid);
    }
  }
  return { send, shallowOut, unshallowOut };
}

/** Encode a send-set as a v2 fetch response body (ack + shallow + packfile). */
export function buildFetchV2Response(
  repo: Repo,
  req: { wants: string[]; haves: string[]; shallow: string[]; depth: number | null },
  pack: Buffer | null,
  shallowOut: string[],
  unshallowOut: string[],
): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments section (introduced by its header line)
  parts.push(pktLine("acknowledgments\n"));
  for (const h of req.haves) {
    const peeled = peelToCommit(repo, h);
    const heldCommit = peeled ?? h;
    const obj = repo.objects.get(heldCommit);
    if (obj && obj.type === "commit") {
      parts.push(pktLine(`ACK ${heldCommit}\n`));
    } else {
      parts.push(pktLine("NAK\n"));
    }
  }
  if (req.haves.length === 0) parts.push(pktLine("NAK\n"));
  parts.push(pktLine("ready\n"));
  parts.push(PKT_DELIM);
  // shallow-info section (only when a depth was requested)
  if (req.depth !== null) {
    parts.push(pktLine("shallow-info\n"));
    for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  // packfile section (omitted entirely when the send-set is empty)
  if (pack !== null) {
    parts.push(pktLine("packfile\n"));
    // Sideband payload is 1 band byte + raw pack bytes; the pkt-line
    // payload cap is 65516, so raw chunks are at most 65515.
    const CHUNK = 65515;
    for (let off = 0; off < pack.length; off += CHUNK) {
      parts.push(pktLineBanded(pack, off, Math.min(CHUNK, pack.length - off)));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Encode a send-set as a v0 fetch response body (ACK/NAK + shallow + pack). */
export function buildFetchV0Response(
  repo: Repo,
  req: { wants: string[]; haves: string[]; shallow: string[]; depth: number | null },
  pack: Buffer | null,
  shallowOut: string[],
  unshallowOut: string[],
): Buffer {
  const parts: Buffer[] = [];
  for (const h of req.haves) {
    const peeled = peelToCommit(repo, h);
    const heldCommit = peeled ?? h;
    const obj = repo.objects.get(heldCommit);
    if (obj && obj.type === "commit") parts.push(pktLine(`ACK ${heldCommit}\n`));
    else parts.push(pktLine("NAK\n"));
  }
  if (req.haves.length === 0) parts.push(pktLine("NAK\n"));
  for (const s of shallowOut) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallowOut) parts.push(pktLine(`unshallow ${s}\n`));
  if (pack !== null) {
    // Sideband payload is 1 band byte + raw pack bytes; the pkt-line
    // payload cap is 65516, so raw chunks are at most 65515.
    const CHUNK = 65515;
    for (let off = 0; off < pack.length; off += CHUNK) {
      parts.push(pktLineBanded(pack, off, Math.min(CHUNK, pack.length - off)));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------- git HTTP

const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine("# service=git-upload-pack\n"),
  PKT_FLUSH,
  pktLine("version 2\n"),
  pktLine("ls-refs=unborn\n"),
  pktLine("fetch=shallow filter\n"),
  pktLine("object-format=sha1\n"),
  pktLine(`agent=${AGENT_NAME}\n`),
  PKT_FLUSH,
]);

export function advertisementV0(repo: Repo, service: "git-upload-pack" | "git-receive-pack"): Buffer {
  const cached = repo.advCache.get(service);
  if (cached) return cached;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps =
    service === "git-upload-pack"
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta agent=${AGENT_NAME} shallow thin-pack`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT_NAME}`;
  const tip = resolveRef(repo, "HEAD");
  const headOid = tip ?? ZERO_OID;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    parts.push(pktLine(`${oid} ${name}\n`));
    const obj = repo.objects.get(oid);
    if (obj && obj.type === "tag" && service === "git-upload-pack") {
      const peeled = peelToCommit(repo, oid);
      if (peeled) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  const buf = Buffer.concat(parts);
  repo.advCache.set(service, buf);
  return buf;
}

export interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefsLines(repo: Repo): string[] {
  const lines: string[] = [];
  const tip = resolveRef(repo, "HEAD");
  if (tip) {
    lines.push(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  } else {
    lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const obj = repo.objects.get(oid);
    if (obj && obj.type === "tag") {
      const peeled = peelToCommit(repo, oid);
      // One line per ref: the peeled commit rides as an attribute, which is
      // what the v2 ls-refs consumer reads (no separate ^{} line).
      lines.push(peeled ? `${oid} ${name} peeled:${peeled}` : `${oid} ${name}`);
    } else {
      lines.push(`${oid} ${name}`);
    }
  }
  return lines;
}

export function lsRefsResponse(repo: Repo, opts: LsRefsOptions): Buffer {
  // The unfiltered response (the common case) is cached per repo.
  if (opts.prefixes.length === 0 && repo.lsRefsCache) return repo.lsRefsCache;
  const all = lsRefsLines(repo);
  const out: Buffer[] = [];
  for (const line of all) {
    let text = line;
    if (!opts.symrefs) text = text.replace(/ symref-target:\S+/, "");
    if (!opts.peel) text = text.replace(/ peeled:[0-9a-f]{40}/, "");
    if (!opts.unborn && text.startsWith("unborn ")) continue;
    // A peeled line for a tag is emitted as "<commit> <tag>^{} peeled:<commit>".
    // When peel is off the peeled attribute is stripped, leaving a plain line.
    if (opts.prefixes.length > 0) {
      const name = text.split(" ")[1] ?? "";
      if (!opts.prefixes.some((p) => name.startsWith(p))) continue;
    }
    out.push(pktLine(`${text}\n`));
  }
  out.push(PKT_FLUSH);
  const buf = Buffer.concat(out);
  if (opts.prefixes.length === 0) repo.lsRefsCache = buf;
  return buf;
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepen: number | null;
  isV2: boolean;
  lsRefs?: LsRefsOptions;
  filter?: string;
}

export function parseFetchRequest(text: string[], isV2: boolean): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepen: null, isV2 };
  let mode: "ls-refs" | "fetch" | null = null;
  const ls: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const rawLine of text) {
    const line = rawLine.replace(/\n$/, "");
    if (isV2 && line === "command=ls-refs") {
      mode = "ls-refs";
      continue;
    }
    if (isV2 && line === "command=fetch") {
      mode = "fetch";
      continue;
    }
    if (mode === "ls-refs") {
      if (line === "peel") ls.peel = true;
      else if (line === "symrefs") ls.symrefs = true;
      else if (line === "unborn") ls.unborn = true;
      else if (line.startsWith("ref-prefix ")) ls.prefixes.push(line.slice("ref-prefix ".length));
      else if (line.startsWith("ref-prefix=")) ls.prefixes.push(line.slice("ref-prefix=".length));
      continue;
    }
    if (line.startsWith("want ")) req.wants.push(line.slice(5).trim());
    else if (line.startsWith("have ")) req.haves.push(line.slice(5).trim());
    else if (line.startsWith("shallow ")) req.shallow.push(line.slice(8).trim());
    else if (line.startsWith("deepen ")) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) {
        req.deepen = n;
        req.depth = n;
      }
    } else if (line.startsWith("deepen-not ")) {
      // not needed by the scenario; treat as a full fetch
    } else if (line.startsWith("deepen-since ")) {
      // not needed by the scenario
    } else if (line === "done") {
      // end of request
    }
  }
  if (mode === "ls-refs") req.lsRefs = ls;
  return req;
}

export function handleFetch(repo: Repo, req: FetchRequest): Buffer {
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  // ls-refs carried inside a v2 upload-pack request
  if (req.lsRefs) return lsRefsResponse(repo, req.lsRefs);
  const key = JSON.stringify({
    w: [...req.wants].sort(),
    h: [...req.haves].sort(),
    s: [...req.shallow].sort(),
    d: req.depth,
    v: req.isV2 ? 2 : 0,
  });
  const cached = repo.packCache.get(key);
  if (cached) {
    if (PROF_ON) {
      profAdd("fetch.hit", Number(process.hrtime.bigint() - t0));
      profInc("fetch.hitN");
    }
    return cached;
  }
  const s0 = PROF_ON ? process.hrtime.bigint() : 0n;
  const sendSet = computeSendSet(repo, req.wants, req.haves, req.shallow, req.depth);
  if (PROF_ON) profAdd("fetch.sendSet", Number(process.hrtime.bigint() - s0));
  const w0 = PROF_ON ? process.hrtime.bigint() : 0n;
  const pack = sendSet.send.size > 0 ? writePack(sendSet.send) : null;
  if (PROF_ON) profAdd("fetch.writePackCall", Number(process.hrtime.bigint() - w0));
  const b0 = PROF_ON ? process.hrtime.bigint() : 0n;
  const resp = req.isV2
    ? buildFetchV2Response(repo, req, pack, sendSet.shallowOut, sendSet.unshallowOut)
    : buildFetchV0Response(repo, req, pack, sendSet.shallowOut, sendSet.unshallowOut);
  if (PROF_ON) {
    profAdd("fetch.buildResp", Number(process.hrtime.bigint() - b0));
    profAdd("fetch.miss", Number(process.hrtime.bigint() - t0));
    profInc("fetch.missN");
  }
  repo.packCache.set(key, resp);
  return resp;
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function parsePushRequest(buf: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, restOffset } = parsePktLines(buf);
  const commands: PushCommand[] = [];
  // Parse command lines straight from the packet payloads: the old code
  // built a full string array via pktLinesToText first (one extra pass +
  // one array). Each command line is "old new ref\0caps\n".
  for (const p of packets) {
    if (p.kind !== "data" || !p.payload) continue;
    const line = p.payload.toString("utf8").replace(/\n$/, "");
    if (!line) continue;
    const nul = line.indexOf("\0");
    const head = nul >= 0 ? line.slice(0, nul) : line;
    const parts = head.split(" ");
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  }
  return { commands, pack: buf.subarray(restOffset) };
}

export interface PushResult {
  ref: string;
  ok: boolean;
  reason: string | null;
}

export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer): PushResult[] {
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  let packObjects: Map<string, GitObject> | null = null;
  if (pack.length > 0) {
    try {
      const parsed = readPack(pack, (oid) => repo.objects.get(oid));
      packObjects = parsed.objects;
    } catch {
      // Malformed pack: the commands still get processed (refused below).
      packObjects = null;
    }
  }
  const results: PushResult[] = [];
  for (const cmd of commands) {
    if (cmd.newOid === ZERO_OID) {
      // Delete a ref.
      if (repo.refs.has(cmd.ref)) {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: null });
      } else {
        results.push({ ref: cmd.ref, ok: false, reason: "no such ref" });
      }
      continue;
    }
    if (packObjects === null && pack.length > 0) {
      results.push({ ref: cmd.ref, ok: false, reason: "pack parse failed" });
      continue;
    }
    if (packObjects) {
      for (const [oid, obj] of packObjects) repo.objects.set(oid, obj);
    }
    const current = repo.refs.get(cmd.ref);
    if (current === cmd.oldOid || (current === undefined && cmd.oldOid === ZERO_OID)) {
      if (cmd.oldOid === ZERO_OID) {
        // New ref: the target must exist in the store.
        if (!repo.objects.has(cmd.newOid)) {
          results.push({ ref: cmd.ref, ok: false, reason: "object not found" });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: null });
      } else if (isAncestorTimed(repo, cmd.oldOid, cmd.newOid)) {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: null });
      } else {
        results.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
      }
    } else {
      results.push({ ref: cmd.ref, ok: false, reason: "non-fast-forward" });
    }
  }
  if (results.some((r) => r.ok)) {
    if (PROF_ON) {
      const i0 = process.hrtime.bigint();
      invalidateRepoCache(repo);
      profAdd("push.invalidate", Number(process.hrtime.bigint() - i0));
    } else {
      invalidateRepoCache(repo);
    }
  }
  if (PROF_ON) {
    profAdd("push.applyPush", Number(process.hrtime.bigint() - t0));
    profInc("push.applyPushN");
  }
  return results;
}

/** isAncestor with a profiler probe (push hot path). */
function isAncestorTimed(repo: Repo, oldOid: string, newOid: string): boolean {
  if (!PROF_ON) return isAncestor(repo, oldOid, newOid);
  const t0 = process.hrtime.bigint();
  const out = isAncestor(repo, oldOid, newOid);
  profAdd("push.isAncestor", Number(process.hrtime.bigint() - t0));
  return out;
}

export function pushReportBuffer(results: PushResult[]): Buffer {
  // One preallocated buffer: [pkt-line("unpack ok"), pkt-line per ref, flush].
  // Each pkt-line is 4-byte hex length + band byte 0x01 + text (no per-line
  // Buffer.concat like the old parts-array build).
  const lines: string[] = ["unpack ok\n"];
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? "rejected"}\n`);
  }
  let total = 4; // flush
  for (const l of lines) total += 4 + 1 + Buffer.byteLength(l, "utf8");
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (const l of lines) {
    const n = Buffer.byteLength(l, "utf8");
    out.write((n + 5).toString(16).padStart(4, "0"), off, 4, "ascii");
    out[off + 4] = 1;
    out.write(l, off + 5, n, "utf8");
    off += 4 + 1 + n;
  }
  out.write("0000", off, 4, "ascii");
  return out;
}

// ------------------------------------------------- issue / pull records

export function createIssueRecord(
  state: ForgeState,
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
): Issue {
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  const number = repo.nextNumber++;
  const now = isoNow();
  const issue: Issue = {
    id: number,
    number,
    title,
    body: body ?? "",
    state: "open",
    labels: labels ?? [],
    seq: nextSeq(state),
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(number, issue);
  if (PROF_ON) profAdd("issue.create", Number(process.hrtime.bigint() - t0));
  return issue;
}

export function issueToJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Manual JSON for the fixed issue shape: byte-identical to
 *  JSON.stringify(issueToJson(repo, issue)) — same key order, same string
 *  escaping (JSON.stringify per string field) — but without building the
 *  intermediate object + labels array. Only used for NEW issues (the write
 *  path); reads use the cached buffer. */
function issueJsonString(repo: Repo, issue: Issue): string {
  let labels = "";
  for (let i = 0; i < issue.labels.length; i++) {
    if (i > 0) labels += ",";
    labels += `{"name":${JSON.stringify(issue.labels[i])}}`;
  }
  return `{"id":${issue.id},"number":${issue.number},"title":${JSON.stringify(issue.title)},"body":${JSON.stringify(issue.body)},"state":${JSON.stringify(issue.state)},"labels":[${labels}],"user":{"login":${JSON.stringify(VIEWER_LOGIN)},"id":${VIEWER_ID}},"created_at":${JSON.stringify(issue.createdAt)},"updated_at":${JSON.stringify(issue.updatedAt)},"html_url":${JSON.stringify(`https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`)}}`;
}

/** The issue's JSON response as bytes, cached: the read workload GETs one
 *  issue 2,000 times, and the response must not be re-stringified or
 *  re-copied per request (sendHttp takes a Buffer as-is). */
export function issueJsonBuffer(repo: Repo, issue: Issue): Buffer {
  const cached = repo.issueJson.get(issue.number);
  if (cached) return cached;
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  const buf = Buffer.from(issueJsonString(repo, issue), "utf8");
  if (PROF_ON) profAdd("issue.stringify", Number(process.hrtime.bigint() - t0));
  repo.issueJson.set(issue.number, buf);
  return buf;
}

export function invalidateIssueCache(repo: Repo, number: number): void {
  repo.issueJson.delete(number);
}

export function createPullRecord(
  state: ForgeState,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
): { pull: Pull; error: string | null } {
  const headRef = `refs/heads/${head}`;
  const baseRef = `refs/heads/${base}`;
  const headSha = resolveRef(repo, headRef);
  const baseSha = resolveRef(repo, baseRef);
  if (!headSha || !baseSha) return { pull: null as unknown as Pull, error: "head or base branch not found" };
  for (const p of repo.pulls.values()) {
    if (p.state === "open" && p.head === head) {
      return { pull: null as unknown as Pull, error: "a pull request already exists for this head branch" };
    }
  }
  const number = repo.nextNumber++;
  const now = isoNow();
  const pull: Pull = {
    id: number,
    number,
    title,
    body: body ?? "",
    state: "open",
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: nextSeq(state),
    createdAt: now,
  };
  repo.pulls.set(number, pull);
  return { pull, error: null };
}

export function pullToJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: pull.createdAt,
  };
}

export function pullMergeable(repo: Repo, pull: Pull): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  if (pull.merged) return "UNKNOWN";
  const baseSha = resolveRef(repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
  const baseCommit = repo.objects.get(baseSha);
  const headCommit = repo.objects.get(pull.headSha);
  if (!baseCommit || !headCommit || baseCommit.type !== "commit" || headCommit.type !== "commit") {
    return "UNKNOWN";
  }
  const baseParts = commitParts(repo, baseSha);
  const headParts = commitParts(repo, pull.headSha);
  if (!baseParts || !headParts) return "UNKNOWN";
  const mergeBase = findMergeBase(repo, baseSha, pull.headSha);
  if (mergeBase === null) return "CONFLICTING";
  const baseTree = new Map<string, { mode: string; oid: string }>();
  const headTree = new Map<string, { mode: string; oid: string }>();
  const mergeTree = new Map<string, { mode: string; oid: string }>();
  const baseObj = repo.objects.get(mergeBase);
  if (baseObj && baseObj.type === "commit") {
    const mergeParts = commitParts(repo, mergeBase);
    if (mergeParts) flattenTree(repo, mergeParts.tree, "", mergeTree);
  }
  flattenTree(repo, baseParts.tree, "", baseTree);
  flattenTree(repo, headParts.tree, "", headTree);
  const paths = new Set<string>([...mergeTree.keys(), ...baseTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const m = mergeTree.get(path);
    const b = baseTree.get(path);
    const h = headTree.get(path);
    const mergeVal = m ? m.oid : null;
    const baseVal = b ? b.oid : null;
    const headVal = h ? h.oid : null;
    const baseChanged = baseVal !== mergeVal;
    const headChanged = headVal !== mergeVal;
    if (baseChanged && headChanged && baseVal !== headVal) return "CONFLICTING";
  }
  return "MERGEABLE";
}

/** Squash-merge a pull: returns the new merge commit oid or null on conflict. */
export function squashMergePull(
  repo: Repo,
  pull: Pull,
  message?: string,
): string | null {
  if (pullMergeable(repo, pull) !== "MERGEABLE") return null;
  const headCommit = repo.objects.get(pull.headSha);
  if (!headCommit || headCommit.type !== "commit") return null;
  const headParts = parseCommit(headCommit.data);
  const baseSha = resolveRef(repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
  const commitMessage = message ?? `${pull.title} (#${pull.number})`;
  const mergeCommit = createCommitRecord(repo, headParts.tree, [baseSha], commitMessage);
  const baseRef = `refs/heads/${pull.base}`;
  repo.refs.set(baseRef, mergeCommit);
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = mergeCommit;
  pull.state = "closed";
  invalidateRepoCache(repo);
  return mergeCommit;
}

export function repoToJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repoFullName(repo),
    owner: { login: repo.owner, id: VIEWER_ID },
    description: repo.description,
    private: repo.priv,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    created_at: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ REST

export interface HttpRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string | null;
}

function jsonResponse(status: number, obj: unknown, extra?: Record<string, string>): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...(extra ?? {}) },
    body: JSON.stringify(obj),
  };
}

function errorJson(status: number, message: string): HttpResponse {
  return jsonResponse(status, { message });
}

function noContentResponse(): HttpResponse {
  return { status: 204, headers: {}, body: null };
}

export function requestId(state: ForgeState): string {
  return `req-${++state.requestSeq}`;
}

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!query) return out;
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) out.set(decodeURIComponent(pair), "");
    else out.set(decodeURIComponent(pair.slice(0, eq)), decodeURIComponent(pair.slice(eq + 1)));
  }
  return out;
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  try {
    const out = { ok: true, value: JSON.parse(body.toString("utf8")) } as { ok: true; value: unknown };
    if (PROF_ON) profAdd("rest.parseJson", Number(process.hrtime.bigint() - t0));
    return out;
  } catch {
    return { ok: false };
  }
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
}

function linkHeader(base: string, page: number, perPage: number, total: number, rel: string): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`);
  if (page > 1) parts.push(`<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`);
  parts.push(`<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`);
  parts.push(`<${base}?page=1&per_page=${perPage}>; rel="first"`);
  void rel;
  return parts.join(", ");
}

export function handleRest(state: ForgeState, req: HttpRequest): HttpResponse {
  const segments = splitPath(req.path);
  // /api/v3 is the prefix; strip it.
  if (segments.length === 0 || segments[0] !== "api" || segments[1] !== "v3") {
    return errorJson(404, "not found");
  }
  const rest = segments.slice(2);
  const query = parseQuery(req.query);
  const method = req.method;

  // ---- root / meta
  if (rest.length === 0) {
    if (method !== "GET") return errorJson(404, "not found");
    return jsonResponse(200, {
      current_user_url: "/api/v3/user",
      repository_url: "/api/v3/repos/{owner}/{repo}",
      rate_limit_url: "/api/v3/rate_limit",
    }, { "x-oauth-scopes": "repo, read:org" });
  }
  if (rest.length === 1 && rest[0] === "meta") {
    if (method !== "GET") return errorJson(404, "not found");
    return jsonResponse(200, {
      verifiable_password_authentication: true,
      installed_version: "3.0.0",
      hooks: ["pre-receive"],
      git: ["3.2.0"],
    });
  }

  // ---- /user
  if (rest[0] === "user") {
    if (rest.length === 1) {
      if (method !== "GET") return errorJson(404, "not found");
      return jsonResponse(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        type: "User",
        html_url: `https://example.invalid/${VIEWER_LOGIN}`,
      });
    }
    if (rest.length === 2 && rest[1] === "repos") {
      if (method === "GET") {
        const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
        const perPage = Math.max(1, Math.min(100, parseInt(query.get("per_page") ?? "30", 10) || 30));
        const all = [...state.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const host = req.headers.host;
        const origin = `http://${typeof host === "string" ? host : "127.0.0.1"}`;
        const base = `${origin}/api/v3/user/repos`;
        return jsonResponse(200, slice.map((r) => repoToJson(r)), {
          link: linkHeader(base, page, perPage, all.length, "next"),
        });
      }
      if (method === "POST") {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return errorJson(400, "invalid JSON body");
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const name = typeof body.name === "string" ? body.name : "";
        if (!name) return errorJson(422, "name is required");
        if (state.repos.has(repoKey(VIEWER_LOGIN, name))) {
          return errorJson(422, "name already exists on this account");
        }
        const repo = createRepoRecord(
          state,
          name,
          typeof body.description === "string" ? body.description : "",
          body.private === true,
        );
        return jsonResponse(201, repoToJson(repo));
      }
      return errorJson(404, "not found");
    }
    return errorJson(404, "not found");
  }

  // ---- /repos/:owner/:repo/...
  if (rest[0] !== "repos" || rest.length < 3) return errorJson(404, "not found");
  const owner = rest[1];
  const repoName = rest[2];
  const repo = getRepo(state, owner, repoName);
  if (!repo) return errorJson(404, "not found");

  const sub = rest.slice(3);

  // /repos/:owner/:repo
  if (sub.length === 0) {
    if (method === "GET") return jsonResponse(200, repoToJson(repo));
    if (method === "PATCH") {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return errorJson(400, "invalid JSON body");
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof body.description === "string") repo.description = body.description;
      if (typeof body.private === "boolean") repo.priv = body.private;
      return jsonResponse(200, repoToJson(repo));
    }
    if (method === "DELETE") {
      state.repos.delete(repoKey(owner, repoName));
      return noContentResponse();
    }
    return errorJson(404, "not found");
  }

  // /branches
  if (sub[0] === "branches") {
    if (sub.length === 1) {
      if (method !== "GET") return errorJson(404, "not found");
      const out: Record<string, unknown>[] = [];
      const names = [...repo.refs.keys()]
        .filter((n) => n.startsWith("refs/heads/"))
        .sort();
      for (const name of names) {
        const oid = repo.refs.get(name)!;
        const commit = repo.objects.get(oid);
        const message = commit && commit.type === "commit" ? parseCommit(commit.data).message : "";
        out.push({
          name: name.slice("refs/heads/".length),
          commit: { sha: oid, message },
          protected: false,
        });
      }
      return jsonResponse(200, out);
    }
    if (sub.length === 2) {
      if (method !== "GET") return errorJson(404, "not found");
      const oid = repo.refs.get(`refs/heads/${sub[1]}`);
      if (!oid) return errorJson(404, "branch not found");
      const commit = repo.objects.get(oid);
      const message = commit && commit.type === "commit" ? parseCommit(commit.data).message : "";
      return jsonResponse(200, {
        name: sub[1],
        commit: { sha: oid, message },
        protected: false,
      });
    }
    return errorJson(404, "not found");
  }

  // /commits
  if (sub[0] === "commits" && sub.length === 1) {
    if (method !== "GET") return errorJson(404, "not found");
    const sha = query.get("sha") ?? repo.defaultBranch;
    const tip = resolveRef(repo, `refs/heads/${sha}`) ?? (isOid(sha) ? sha : undefined);
    if (!tip) return errorJson(404, "branch or commit not found");
    const chain = commitChain(repo, tip, 30);
    const out = chain.map(({ oid, commit }) => ({
      sha: oid,
      commit: { message: commit.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
    }));
    return jsonResponse(200, out);
  }

  // /git/refs
  if (sub[0] === "git" && sub[1] === "refs") {
    if (sub.length === 2) {
      if (method === "GET") {
        const out: Record<string, unknown>[] = [];
        for (const name of [...repo.refs.keys()].sort()) {
          out.push({ ref: name, object: { sha: repo.refs.get(name)!, type: "commit" } });
        }
        return jsonResponse(200, out);
      }
      if (method === "POST") {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return errorJson(400, "invalid JSON body");
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const ref = typeof body.ref === "string" ? body.ref : "";
        const sha = typeof body.sha === "string" ? body.sha : "";
        if (!ref || !sha) return errorJson(422, "ref and sha are required");
        if (!repo.objects.has(sha)) return errorJson(422, "object not found");
        repo.refs.set(ref, sha);
        invalidateRepoCache(repo);
        return jsonResponse(201, { ref, object: { sha, type: "commit" } });
      }
      return errorJson(404, "not found");
    }
    if (sub.length >= 4 && sub[2] === "heads") {
      const branch = sub.slice(3).join("/");
      if (method !== "GET") return errorJson(404, "not found");
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return errorJson(404, "ref not found");
      return jsonResponse(200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: "commit" } });
    }
    return errorJson(404, "not found");
  }

  // /contents/:path
  if (sub[0] === "contents") {
    const pathSegs = sub.slice(1);
    if (pathSegs.length === 0) return errorJson(404, "not found");
    const path = pathSegs.join("/");
    const tip = resolveRef(repo, "HEAD");
    if (method === "GET") {
      const refName = query.get("ref") ?? repo.defaultBranch;
      const refOid = resolveRef(repo, `refs/heads/${refName}`) ?? (isOid(refName) ? refName : undefined);
      if (!refOid) return errorJson(404, "ref not found");
      const commit = repo.objects.get(refOid);
      if (!commit || commit.type !== "commit") return errorJson(404, "ref not found");
      const treeOid = parseCommit(commit.data).tree;
      const found = lookupPath(repo, treeOid, pathSegs);
      if (!found) return errorJson(404, "not found");
      if (found.mode === "40000") {
        const entries = treeEntriesOf(repo, found.oid).map((e) => ({
          name: e.name,
          path: `${path}/${e.name}`,
          sha: e.oid,
          type: e.mode === "40000" ? "dir" : "file",
          size: e.mode === "40000" ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
        }));
        return jsonResponse(200, entries);
      }
      const obj = repo.objects.get(found.oid);
      const data = obj ? obj.data : Buffer.alloc(0);
      return jsonResponse(200, {
        name: pathSegs[pathSegs.length - 1],
        path,
        sha: found.oid,
        size: data.length,
        type: "file",
        encoding: "base64",
        content: data.toString("base64"),
      });
    }
    if (method === "PUT") {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return errorJson(400, "invalid JSON body");
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const contentB64 = typeof body.content === "string" ? body.content : "";
      const message = typeof body.message === "string" ? body.message : "update file";
      const sha = typeof body.sha === "string" ? body.sha : undefined;
      const branch = typeof body.branch === "string" ? body.branch : repo.defaultBranch;
      const targetRef = `refs/heads/${branch}`;
      const tip = resolveRef(repo, targetRef);
      if (!tip) {
        // Empty repo (or empty branch): create the first commit on it.
        const blobOid = storeObject(repo, "blob", Buffer.from(contentB64, "base64"));
        const treeOid = buildTreeWithPath(repo, null, pathSegs, blobOid);
        const commitOid = createCommitRecord(repo, treeOid, [], message);
        repo.refs.set(targetRef, commitOid);
        invalidateRepoCache(repo);
        return jsonResponse(201, {
          content: { name: pathSegs[pathSegs.length - 1], path, sha: blobOid, size: Buffer.from(contentB64, "base64").length, encoding: "base64" },
          commit: { sha: commitOid, message },
        });
      }
      const tipCommit = repo.objects.get(tip);
      if (!tipCommit || tipCommit.type !== "commit") return errorJson(404, "not found");
      const tipParts = parseCommit(tipCommit.data);
      const existing = lookupPath(repo, tipParts.tree, pathSegs);
      if (sha && existing && existing.oid !== sha) return errorJson(409, "sha mismatch");
      if (sha && !existing) return errorJson(409, "sha mismatch");
      const blobData = Buffer.from(contentB64, "base64");
      const blobOid = storeObject(repo, "blob", blobData);
      const treeOid = buildTreeWithPath(repo, tipParts.tree, pathSegs, blobOid);
      const commitOid = createCommitRecord(repo, treeOid, [tip], message);
      repo.refs.set(targetRef, commitOid);
      invalidateRepoCache(repo);
      return jsonResponse(existing ? 200 : 201, {
        content: { name: pathSegs[pathSegs.length - 1], path, sha: blobOid, size: blobData.length, encoding: "base64" },
        commit: { sha: commitOid, message },
      });
    }
    if (method === "DELETE") {
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return errorJson(400, "invalid JSON body");
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      const message = typeof body.message === "string" ? body.message : "delete file";
      const sha = typeof body.sha === "string" ? body.sha : undefined;
      if (!tip) return errorJson(404, "not found");
      const tipCommit = repo.objects.get(tip);
      if (!tipCommit || tipCommit.type !== "commit") return errorJson(404, "not found");
      const tipParts = parseCommit(tipCommit.data);
      const existing = lookupPath(repo, tipParts.tree, pathSegs);
      if (!existing) return errorJson(404, "not found");
      if (sha && existing.oid !== sha) return errorJson(409, "sha mismatch");
      const newTree = buildTreeWithoutPath(repo, tipParts.tree, pathSegs);
      const treeOid = newTree ?? storeObject(repo, "tree", buildTree([]));
      const commitOid = createCommitRecord(repo, treeOid, [tip], message);
      repo.refs.set(defaultBranchRefName(repo), commitOid);
      invalidateRepoCache(repo);
      return jsonResponse(200, { commit: { sha: commitOid, message } });
    }
    return errorJson(404, "not found");
  }

  // /labels
  if (sub[0] === "labels") {
    if (sub.length === 1) {
      if (method === "GET") {
        return jsonResponse(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      }
      if (method === "POST") {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return errorJson(400, "invalid JSON body");
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const name = typeof body.name === "string" ? body.name : "";
        const color = typeof body.color === "string" ? body.color : "ededed";
        if (!name) return errorJson(422, "name is required");
        const label: Label = { name, color };
        repo.labels.set(name, label);
        return jsonResponse(201, { name, color });
      }
      return errorJson(404, "not found");
    }
    return errorJson(404, "not found");
  }

  // /issues
  if (sub[0] === "issues") {
    if (sub.length === 1) {
      if (method === "GET") {
        const stateFilter = query.get("state") ?? "open";
        const sort = query.get("sort") ?? "created";
        const direction = query.get("direction") ?? "desc";
        const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
        const perPage = Math.max(1, Math.min(100, parseInt(query.get("per_page") ?? "30", 10) || 30));
        let list = [...repo.issues.values()];
        if (stateFilter !== "all") list = list.filter((i) => i.state === stateFilter);
        list.sort((a, b) => {
          const d = sort === "created" ? a.seq - b.seq : a.seq - b.seq;
          return direction === "asc" ? d : -d;
        });
        const slice = list.slice((page - 1) * perPage, page * perPage);
        return jsonResponse(200, slice.map((i) => issueToJson(repo, i)));
      }
      if (method === "POST") {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return errorJson(400, "invalid JSON body");
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const title = typeof body.title === "string" ? body.title : "";
        if (!title) return errorJson(422, "title is required");
        const labels = Array.isArray(body.labels)
          ? (body.labels as unknown[]).map((l) => String(l))
          : [];
        for (const l of labels) {
          if (!repo.labels.has(l)) return errorJson(422, `label ${l} does not exist`);
        }
        const issue = createIssueRecord(state, repo, title, typeof body.body === "string" ? body.body : "", labels);
        return { status: 201, headers: { "content-type": "application/json" }, body: issueJsonBuffer(repo, issue) };
      }
      return errorJson(404, "not found");
    }
    const num = parseInt(sub[1], 10);
    if (!Number.isFinite(num)) return errorJson(404, "not found");
    const issue = repo.issues.get(num);
    if (!issue) return errorJson(404, "not found");
    if (sub.length === 2) {
      if (method === "GET") {
        return { status: 200, headers: { "content-type": "application/json" }, body: issueJsonBuffer(repo, issue) };
      }
      if (method === "PATCH") {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return errorJson(400, "invalid JSON body");
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        if (typeof body.title === "string") issue.title = body.title;
        if (typeof body.body === "string") issue.body = body.body;
        if (typeof body.state === "string" && (body.state === "open" || body.state === "closed")) {
          issue.state = body.state;
        }
        issue.updatedAt = isoNow();
        invalidateIssueCache(repo, num);
        return { status: 200, headers: { "content-type": "application/json" }, body: issueJsonBuffer(repo, issue) };
      }
      return errorJson(404, "not found");
    }
    if (sub.length === 3 && sub[2] === "comments") {
      if (method === "GET") {
        const list = repo.comments.get(num) ?? [];
        return jsonResponse(200, list.map((c) => ({
          id: c.id,
          body: c.body,
          user: { login: c.user, id: VIEWER_ID },
          created_at: c.createdAt,
        })));
      }
      if (method === "POST") {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return errorJson(400, "invalid JSON body");
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const text = typeof body.body === "string" ? body.body : "";
        const comment: Comment = { id: state.nextCommentId++, body: text, user: VIEWER_LOGIN, createdAt: isoNow() };
        const list = repo.comments.get(num) ?? [];
        list.push(comment);
        repo.comments.set(num, list);
        return jsonResponse(201, {
          id: comment.id,
          body: comment.body,
          user: { login: comment.user, id: VIEWER_ID },
          created_at: comment.createdAt,
        });
      }
      return errorJson(404, "not found");
    }
    return errorJson(404, "not found");
  }

  // /pulls
  if (sub[0] === "pulls") {
    if (sub.length === 1) {
      if (method === "GET") {
        const stateFilter = query.get("state") ?? "open";
        const page = Math.max(1, parseInt(query.get("page") ?? "1", 10) || 1);
        const perPage = Math.max(1, Math.min(100, parseInt(query.get("per_page") ?? "30", 10) || 30));
        let list = [...repo.pulls.values()];
        if (stateFilter !== "all") list = list.filter((p) => p.state === stateFilter);
        list.sort((a, b) => b.seq - a.seq);
        const slice = list.slice((page - 1) * perPage, page * perPage);
        return jsonResponse(200, slice.map((p) => pullToJson(repo, p)));
      }
      if (method === "POST") {
        const parsed = parseJsonBody(req.body);
        if (!parsed.ok) return errorJson(400, "invalid JSON body");
        const body = (parsed.value ?? {}) as Record<string, unknown>;
        const title = typeof body.title === "string" ? body.title : "";
        const head = typeof body.head === "string" ? body.head : "";
        const base = typeof body.base === "string" ? body.base : "";
        if (!title || !head || !base) return errorJson(422, "title, head and base are required");
        const { pull, error } = createPullRecord(state, repo, title, typeof body.body === "string" ? body.body : "", head, base);
        if (error) {
          const status = error.includes("already exists") ? 422 : 422;
          return errorJson(status, error);
        }
        return jsonResponse(201, pullToJson(repo, pull));
      }
      return errorJson(404, "not found");
    }
    const num = parseInt(sub[1], 10);
    if (!Number.isFinite(num)) return errorJson(404, "not found");
    const pull = repo.pulls.get(num);
    if (!pull) return errorJson(404, "not found");
    if (sub.length === 2) {
      if (method !== "GET") return errorJson(404, "not found");
      return jsonResponse(200, pullToJson(repo, pull));
    }
    if (sub.length === 3 && sub[2] === "files") {
      if (method !== "GET") return errorJson(404, "not found");
      const baseCommit = repo.objects.get(pull.baseSha);
      const headCommit = repo.objects.get(pull.headSha);
      const baseTree = baseCommit && baseCommit.type === "commit" ? parseCommit(baseCommit.data).tree : null;
      const headTree = headCommit && headCommit.type === "commit" ? parseCommit(headCommit.data).tree : null;
      const files = diffTrees(repo, baseTree, headTree);
      return jsonResponse(200, files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })));
    }
    if (sub.length === 3 && sub[2] === "merge") {
      if (method !== "PUT") return errorJson(404, "not found");
      if (pull.merged) {
        return jsonResponse(200, { merged: true, sha: pull.mergeCommitSha, message: "already merged" });
      }
      const parsed = parseJsonBody(req.body);
      if (!parsed.ok) return errorJson(400, "invalid JSON body");
      const body = (parsed.value ?? {}) as Record<string, unknown>;
      if (pullMergeable(repo, pull) !== "MERGEABLE") {
        return errorJson(405, "merge conflict");
      }
      const commitMessage = typeof body.commit_message === "string" ? body.commit_message : undefined;
      const mergeSha = squashMergePull(repo, pull, commitMessage);
      if (!mergeSha) return errorJson(405, "merge conflict");
      return jsonResponse(200, { merged: true, sha: mergeSha, message: commitMessage ?? `${pull.title} (#${pull.number})` });
    }
    return errorJson(404, "not found");
  }

  return errorJson(404, "not found");
}

// ------------------------------------------------------------ GraphQL

interface GqlValue {
  kind: "var" | "string" | "int" | "float" | "boolean" | "null" | "enum" | "list" | "object";
  value?: unknown;
  items?: GqlValue[];
  fields?: { name: string; value: GqlValue }[];
}

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlField[];
  fragmentType: string | null;
  kind: "field" | "fragment" | "inline";
}

interface GqlOperation {
  type: "query" | "mutation";
  selections: GqlField[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "." && src.slice(i, i + 3) === "...") {
      tokens.push("...");
      i += 3;
      continue;
    }
    if ("{}()[]:!=$@".includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === "n") out += "\n";
          else if (esc === "t") out += "\t";
          else if (esc === "r") out += "\r";
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9\-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+\-]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    return this.tokens[this.pos++];
  }
  private expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok} in GraphQL document, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok === "query" || tok === "mutation") {
        this.next();
        let name: string | undefined;
        if (this.peek() && this.peek() !== "{" && this.peek() !== "(") name = this.next();
        if (this.peek() === "(") this.skipParens();
        void name;
        ops.push({ type: tok as "query" | "mutation", selections: this.parseSelectionSet() });
      } else if (tok === "{") {
        ops.push({ type: "query", selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${tok} in GraphQL document`);
      }
    }
    return ops;
  }

  private skipParens(): void {
    this.expect("(");
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t === "(") depth++;
      else if (t === ")") depth--;
    }
  }

  private parseSelectionSet(): GqlField[] {
    this.expect("{");
    const out: GqlField[] = [];
    while (this.peek() !== "}") {
      out.push(this.parseField());
    }
    this.expect("}");
    return out;
  }

  private parseField(): GqlField {
    const tok = this.peek();
    if (tok === "...") {
      this.next();
      if (this.peek() === "on") {
        this.next();
        const typeName = this.next();
        return { name: "", alias: null, args: {}, selections: this.parseSelectionSet(), fragmentType: typeName, kind: "inline" };
      }
      const fragName = this.next();
      return { name: fragName, alias: null, args: {}, selections: [], fragmentType: null, kind: "fragment" };
    }
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ":") {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === "(") {
      this.next();
      while (this.peek() !== ")") {
        const argName = this.next();
        this.expect(":");
        args[argName] = this.parseValue();
      }
      this.expect(")");
    }
    const selections = this.peek() === "{" ? this.parseSelectionSet() : [];
    return { name, alias, args, selections, fragmentType: null, kind: "field" };
  }

  private parseValue(): GqlValue {
    const tok = this.next();
    if (tok === "$") return { kind: "var", value: this.next() };
    if (tok === "[") {
      const items: GqlValue[] = [];
      while (this.peek() !== "]") items.push(this.parseValue());
      this.expect("]");
      return { kind: "list", items };
    }
    if (tok === "{") {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== "}") {
        const name = this.next();
        this.expect(":");
        fields.push({ name, value: this.parseValue() });
      }
      this.expect("}");
      return { kind: "object", fields };
    }
    if (tok === "true" || tok === "false") return { kind: "boolean", value: tok === "true" };
    if (tok === "null") return { kind: "null", value: null };
    if (tok.startsWith('"')) return { kind: "string", value: JSON.parse(tok) };
    if (/^-?[0-9]+$/.test(tok)) return { kind: "int", value: parseInt(tok, 10) };
    if (/^-?[0-9]*\.[0-9]+([eE][+-]?[0-9]+)?$/.test(tok)) return { kind: "float", value: parseFloat(tok) };
    return { kind: "enum", value: tok };
  }
}

function gqlResolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case "var":
      return variables[String(v.value)];
    case "list":
      return (v.items ?? []).map((x) => gqlResolveValue(x, variables));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const f of v.fields ?? []) out[f.name] = gqlResolveValue(f.value, variables);
      return out;
    }
    default:
      return v.value;
  }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ["viewer", "repository", "node", "search", "__type", "__schema"],
  Mutation: ["createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"],
  Viewer: ["login", "id", "name", "email"],
  User: ["login", "id", "name", "email"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "private", "createdAt", "updatedAt"],
  Issue: ["id", "number", "title", "body", "state", "url", "author", "createdAt", "updatedAt", "comments"],
  PullRequest: ["id", "number", "title", "body", "state", "headRefName", "baseRefName", "mergeable", "merged", "files", "author", "createdAt", "updatedAt"],
  Ref: ["name", "target"],
  IssueConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  PullRequestConnection: ["nodes", "edges", "pageInfo", "totalCount"],
  PullRequestFileConnection: ["nodes", "edges", "pageInfo"],
  IssueEdge: ["node", "cursor"],
  PullRequestEdge: ["node", "cursor"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
  PullRequestFile: ["path", "additions", "deletions", "changes"],
  IssueComment: ["id", "body", "author", "createdAt"],
  CommentEdge: ["node", "cursor"],
  CreateIssuePayload: ["issue", "clientMutationId"],
  CloseIssuePayload: ["issue", "clientMutationId"],
  CreatePullRequestPayload: ["pullRequest", "clientMutationId"],
  MergePullRequestPayload: ["pullRequest", "clientMutationId"],
  AddCommentPayload: ["commentEdge", "clientMutationId"],
  __Type: ["name", "fields", "enumValues", "kind"],
  __Field: ["name", "type"],
  __EnumValue: ["name"],
};

const SEARCH_TYPE_VALUES = ["ISSUE", "PULL_REQUEST", "REPOSITORY", "USER", "ORGANIZATION", "DISCUSSION", "COMMIT"];

interface GqlContext {
  state: ForgeState;
  errors: { message: string }[];
  variables: Record<string, unknown>;
}

/** Resolve a repository reference that may be a numeric databaseId or a
 *  base64 global id ("Repository:<dbId>"). */
function findRepoById(state: ForgeState, v: unknown): Repo | undefined {
  if (typeof v === "number") return [...state.repos.values()].find((r) => r.id === v);
  const s = String(v ?? "");
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return [...state.repos.values()].find((r) => r.id === n);
  }
  const decoded = b64decode(s);
  const m = /^Repository:(\d+)$/.exec(decoded);
  if (m) {
    const n = parseInt(m[1], 10);
    return [...state.repos.values()].find((r) => r.id === n);
  }
  return undefined;
}

/** Decode a global node id ("Kind:<dbId>") or a plain numeric id. */
function decodeNodeId(v: unknown): { kind: string; dbId: number } | null {
  if (typeof v === "number") return { kind: "", dbId: v };
  const s = String(v ?? "");
  if (/^\d+$/.test(s)) return { kind: "", dbId: parseInt(s, 10) };
  const decoded = b64decode(s);
  const m = /^([A-Za-z]+):(\d+)$/.exec(decoded);
  if (m) return { kind: m[1], dbId: parseInt(m[2], 10) };
  return null;
}

function gqlError(ctx: GqlContext, message: string): void {
  ctx.errors.push({ message });
}

function gqlSelect(
  ctx: GqlContext,
  typeName: string,
  value: unknown,
  selections: GqlField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.kind === "fragment") {
      // Named fragments are not used by the scenario documents.
      continue;
    }
    if (field.kind === "inline") {
      const sub = gqlSelect(ctx, typeName, value, field.selections);
      Object.assign(out, sub);
      continue;
    }
    const key = field.alias ?? field.name;
    out[key] = gqlResolveField(ctx, typeName, value, field);
  }
  return out;
}

function gqlResolveField(ctx: GqlContext, typeName: string, value: unknown, field: GqlField): unknown {
  const name = field.name;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = gqlResolveValue(v, ctx.variables);
  const known = TYPE_FIELDS[typeName];
  if (known && !known.includes(name)) {
    gqlError(ctx, `Cannot query field "${name}" on type "${typeName}".`);
    return undefined;
  }
  const repo = value as Repo | null;
  switch (typeName) {
    case "Query": {
      if (name === "viewer") {
        return gqlSelect(ctx, "Viewer", null, field.selections);
      }
      if (name === "repository") {
        const owner = String(args.owner ?? "");
        const rname = String(args.name ?? "");
        const found = getRepo(ctx.state, owner, rname);
        if (!found) return null;
        return gqlSelect(ctx, "Repository", found, field.selections);
      }
      if (name === "node") {
        const id = String(args.id ?? "");
        const decoded = b64decode(id);
        const [kind, dbIdStr] = decoded.split(":");
        const dbId = parseInt(dbIdStr, 10);
        if (!Number.isFinite(dbId)) return null;
        if (kind === "Repository") {
          for (const r of ctx.state.repos.values()) {
            if (r.id === dbId) return gqlSelect(ctx, "Repository", r, field.selections);
          }
          return null;
        }
        if (kind === "Issue" || kind === "PullRequest") {
          for (const r of ctx.state.repos.values()) {
            const item = kind === "Issue" ? r.issues.get(dbId) : r.pulls.get(dbId);
            if (item) {
              return gqlSelect(ctx, kind, { repo: r, item }, field.selections);
            }
          }
          return null;
        }
        return null;
      }
      if (name === "__type") {
        const tname = String(args.name ?? "");
        if (!TYPE_FIELDS[tname] && tname !== "SearchType") return null;
        return gqlSelect(ctx, "__Type", tname, field.selections);
      }
      if (name === "__schema") return {};
      return null;
    }
    case "Viewer":
    case "User": {
      if (name === "login") return VIEWER_LOGIN;
      if (name === "id") return globalId("User", VIEWER_ID);
      if (name === "name") return VIEWER_NAME;
      if (name === "email") return VIEWER_EMAIL;
      return null;
    }
    case "Repository": {
      if (!repo) return null;
      if (name === "id") return globalId("Repository", repo.id);
      if (name === "databaseId") return repo.id;
      if (name === "name") return repo.name;
      if (name === "nameWithOwner") return repoFullName(repo);
      if (name === "owner") return gqlSelect(ctx, "User", null, field.selections);
      if (name === "defaultBranchRef") {
        const tip = resolveRef(repo, "HEAD");
        if (!tip) return null;
        return gqlSelect(ctx, "Ref", { name: repo.defaultBranch, oid: tip }, field.selections);
      }
      if (name === "viewerPermission") return "ADMIN";
      if (name === "hasIssuesEnabled") return true;
      if (name === "description") return repo.description;
      if (name === "private") return repo.priv;
      if (name === "createdAt") return isoNow();
      if (name === "updatedAt") return isoNow();
      if (name === "issue") {
        const num = Number(args.number);
        const issue = repo.issues.get(num);
        if (!issue) return null;
        return gqlSelect(ctx, "Issue", { repo, item: issue }, field.selections);
      }
      if (name === "issues") return gqlIssuesConnection(ctx, repo, args, field);
      if (name === "pullRequests") return gqlPullsConnection(ctx, repo, args, field);
      if (name === "pullRequest") {
        const num = Number(args.number);
        const pull = repo.pulls.get(num);
        if (!pull) return null;
        return gqlSelect(ctx, "PullRequest", { repo, item: pull }, field.selections);
      }
      return null;
    }
    case "Issue": {
      const wrapped = value as { repo: Repo; item: Issue };
      const issue = wrapped.item;
      if (name === "id") return globalId("Issue", issue.id);
      if (name === "number") return issue.number;
      if (name === "title") return issue.title;
      if (name === "body") return issue.body;
      if (name === "state") return issue.state === "open" ? "OPEN" : "CLOSED";
      if (name === "url") return `https://example.invalid/${wrapped.repo.owner}/${wrapped.repo.name}/issues/${issue.number}`;
      if (name === "author") return gqlSelect(ctx, "User", null, field.selections);
      if (name === "createdAt") return issue.createdAt;
      if (name === "updatedAt") return issue.updatedAt;
      if (name === "comments") return { nodes: [] };
      return null;
    }
    case "PullRequest": {
      const wrapped = value as { repo: Repo; item: Pull };
      const pull = wrapped.item;
      if (name === "id") return globalId("PullRequest", pull.id);
      if (name === "number") return pull.number;
      if (name === "title") return pull.title;
      if (name === "body") return pull.body;
      if (name === "state") return pull.merged ? "MERGED" : pull.state === "open" ? "OPEN" : "CLOSED";
      if (name === "headRefName") return pull.head;
      if (name === "baseRefName") return pull.base;
      if (name === "mergeable") return pullMergeable(wrapped.repo, pull);
      if (name === "merged") return pull.merged;
      if (name === "author") return gqlSelect(ctx, "User", null, field.selections);
      if (name === "createdAt") return pull.createdAt;
      if (name === "updatedAt") return pull.createdAt;
      if (name === "files") {
        const baseCommit = wrapped.repo.objects.get(pull.baseSha);
        const headCommit = wrapped.repo.objects.get(pull.headSha);
        const baseTree = baseCommit && baseCommit.type === "commit" ? parseCommit(baseCommit.data).tree : null;
        const headTree = headCommit && headCommit.type === "commit" ? parseCommit(headCommit.data).tree : null;
        const files = diffTrees(wrapped.repo, baseTree, headTree);
        return gqlSelect(ctx, "PullRequestFileConnection", files, field.selections);
      }
      return null;
    }
    case "Ref": {
      const ref = value as { name: string; oid: string };
      if (name === "name") return ref.name;
      if (name === "target") return null;
      return null;
    }
    case "IssueConnection":
    case "PullRequestConnection":
    case "PullRequestFileConnection": {
      const nodes = value as unknown[];
      if (name === "nodes") {
        const typeName2 = typeName === "IssueConnection" ? "Issue" : typeName === "PullRequestConnection" ? "PullRequest" : "PullRequestFile";
        return (nodes as { repo: Repo; item: Issue | Pull }[] | FileDiff[]).map((n) =>
          gqlSelect(ctx, typeName2, n, field.selections),
        );
      }
      if (name === "edges") return [];
      if (name === "pageInfo") {
        return gqlSelect(ctx, "PageInfo", value, field.selections);
      }
      if (name === "totalCount") return nodes.length;
      return null;
    }
    case "PageInfo": {
      const ctx2 = value as { __pageInfo?: { hasNextPage: boolean; endCursor: string | null } };
      const info = ctx2.__pageInfo;
      if (name === "hasNextPage") return info ? info.hasNextPage : false;
      if (name === "hasPreviousPage") return false;
      if (name === "endCursor") return info ? info.endCursor : null;
      if (name === "startCursor") return null;
      return null;
    }
    case "PullRequestFile": {
      const f = value as FileDiff;
      if (name === "path") return f.filename;
      if (name === "additions") return f.additions;
      if (name === "deletions") return f.deletions;
      if (name === "changes") return f.changes;
      return null;
    }
    case "IssueComment": {
      const c = value as Comment;
      if (name === "id") return globalId("IssueComment", c.id);
      if (name === "body") return c.body;
      if (name === "author") return gqlSelect(ctx, "User", null, field.selections);
      if (name === "createdAt") return c.createdAt;
      return null;
    }
    case "CommentEdge": {
      const c = value as Comment;
      if (name === "node") return gqlSelect(ctx, "IssueComment", c, field.selections);
      if (name === "cursor") return b64encode(`cursor:${c.id}`);
      return null;
    }
    case "__Type": {
      const tname = value as string;
      if (name === "name") return tname;
      if (name === "kind") return tname === "SearchType" ? "ENUM" : "OBJECT";
      if (name === "fields") {
        const fields = (TYPE_FIELDS[tname] ?? []).map((f) => ({ name: f }));
        return fields.map((f) => gqlSelect(ctx, "__Field", f, field.selections));
      }
      if (name === "enumValues") {
        if (tname !== "SearchType") return null;
        return SEARCH_TYPE_VALUES.map((v) => gqlSelect(ctx, "__EnumValue", { name: v }, field.selections));
      }
      return null;
    }
    case "__Field": {
      const f = value as { name: string };
      if (name === "name") return f.name;
      if (name === "type") return null;
      return null;
    }
    case "__EnumValue": {
      const v = value as { name: string };
      if (name === "name") return v.name;
      return null;
    }
    default:
      return null;
  }
}

function gqlIssuesConnection(
  ctx: GqlContext,
  repo: Repo,
  args: Record<string, unknown>,
  field: GqlField,
): Record<string, unknown> {
  let list = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { direction?: string } | undefined;
  const direction = String(orderBy?.direction ?? "ASC").toUpperCase();
  if (direction === "DESC") list = list.reverse();
  const first = typeof args.first === "number" ? args.first : list.length;
  const after = args.after !== undefined && args.after !== null ? Number(b64decode(String(args.after)).split(":")[1]) : 0;
  const start = after > 0 ? after : 0;
  const page = list.slice(start, start + first);
  const hasNext = start + first < list.length;
  const endCursor = page.length > 0 ? b64encode(`cursor:${start + page.length}`) : null;
  const wrapped = page.map((item) => ({ repo, item }));
  const connValue = Object.assign(wrapped, {
    __pageInfo: { hasNextPage: hasNext, endCursor },
  });
  return gqlSelect(ctx, "IssueConnection", connValue, field.selections);
}

function gqlPullsConnection(
  ctx: GqlContext,
  repo: Repo,
  args: Record<string, unknown>,
  field: GqlField,
): Record<string, unknown> {
  const list = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
  const first = typeof args.first === "number" ? args.first : list.length;
  const after = args.after !== undefined && args.after !== null ? Number(b64decode(String(args.after)).split(":")[1]) : 0;
  const start = after > 0 ? after : 0;
  const page = list.slice(start, start + first);
  const hasNext = start + first < list.length;
  const endCursor = page.length > 0 ? b64encode(`cursor:${start + page.length}`) : null;
  const wrapped = page.map((item) => ({ repo, item }));
  const connValue = Object.assign(wrapped, {
    __pageInfo: { hasNextPage: hasNext, endCursor },
  });
  return gqlSelect(ctx, "PullRequestConnection", connValue, field.selections);
}

function gqlExecuteMutation(ctx: GqlContext, op: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of op.selections) {
    const key = field.alias ?? field.name;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = gqlResolveValue(v, variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === "createIssue") {
      const repo = findRepoById(ctx.state, input.repositoryId);
      if (!repo) {
        gqlError(ctx, `repository ${input.repositoryId} not found`);
        out[key] = null;
        continue;
      }
      const issue = createIssueRecord(ctx.state, repo, String(input.title ?? ""), String(input.body ?? ""), []);
      out[key] = gqlSelectPayload(ctx, "CreateIssuePayload", { repo, item: issue }, field.selections);
    } else if (field.name === "closeIssue") {
      const decoded = decodeNodeId(input.issueId);
      const dbId = decoded ? decoded.dbId : NaN;
      let target: { repo: Repo; item: Issue } | null = null;
      for (const r of ctx.state.repos.values()) {
        const it = r.issues.get(dbId);
        if (it) {
          target = { repo: r, item: it };
          break;
        }
      }
      if (!target) {
        gqlError(ctx, `issue ${input.issueId} not found`);
        out[key] = null;
        continue;
      }
      target.item.state = "closed";
      target.item.updatedAt = isoNow();
      invalidateIssueCache(target.repo, target.item.number);
      out[key] = gqlSelectPayload(ctx, "CloseIssuePayload", target, field.selections);
    } else if (field.name === "createPullRequest") {
      const repo = findRepoById(ctx.state, input.repositoryId);
      if (!repo) {
        gqlError(ctx, `repository ${input.repositoryId} not found`);
        out[key] = null;
        continue;
      }
      const { pull, error } = createPullRecord(
        ctx.state,
        repo,
        String(input.title ?? ""),
        String(input.body ?? ""),
        String(input.headRefName ?? ""),
        String(input.baseRefName ?? ""),
      );
      if (error || !pull) {
        gqlError(ctx, error ?? "failed to create pull request");
        out[key] = null;
        continue;
      }
      out[key] = gqlSelectPayload(ctx, "CreatePullRequestPayload", { repo, item: pull }, field.selections);
    } else if (field.name === "mergePullRequest") {
      const decoded = decodeNodeId(input.pullRequestId);
      const dbId = decoded ? decoded.dbId : NaN;
      let target: { repo: Repo; item: Pull } | null = null;
      for (const r of ctx.state.repos.values()) {
        const it = r.pulls.get(dbId);
        if (it) {
          target = { repo: r, item: it };
          break;
        }
      }
      if (!target) {
        gqlError(ctx, `pull request ${input.pullRequestId} not found`);
        out[key] = null;
        continue;
      }
      if (pullMergeable(target.repo, target.item) !== "MERGEABLE") {
        gqlError(ctx, "merge conflict");
        out[key] = null;
        continue;
      }
      squashMergePull(target.repo, target.item);
      out[key] = gqlSelectPayload(ctx, "MergePullRequestPayload", target, field.selections);
    } else if (field.name === "addComment") {
      const decoded = decodeNodeId(input.subjectId);
      const kind = decoded ? decoded.kind : "";
      const dbId = decoded ? decoded.dbId : NaN;
      let target: { repo: Repo; item: Issue | Pull } | null = null;
      for (const r of ctx.state.repos.values()) {
        const it = kind === "PullRequest" ? r.pulls.get(dbId) : r.issues.get(dbId);
        if (it) {
          target = { repo: r, item: it };
          break;
        }
      }
      if (!target) {
        gqlError(ctx, `subject ${input.subjectId} not found`);
        out[key] = null;
        continue;
      }
      const comment: Comment = {
        id: ctx.state.nextCommentId++,
        body: String(input.body ?? ""),
        user: VIEWER_LOGIN,
        createdAt: isoNow(),
      };
      const list = target.repo.comments.get(target.item.number) ?? [];
      list.push(comment);
      target.repo.comments.set(target.item.number, list);
      out[key] = gqlSelectPayload(ctx, "AddCommentPayload", { repo: target.repo, item: target.item, comment }, field.selections);
    } else {
      gqlError(ctx, `Cannot query field "${field.name}" on type "Mutation".`);
      out[key] = null;
    }
  }
  return out;
}

function gqlSelectPayload(ctx: GqlContext, typeName: string, value: unknown, selections: GqlField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    const key = field.alias ?? field.name;
    if (field.name === "issue" || field.name === "pullRequest") {
      const wrapped = value as { repo: Repo; item: Issue | Pull };
      const t = field.name === "issue" ? "Issue" : "PullRequest";
      out[key] = gqlSelect(ctx, t, wrapped, field.selections);
    } else if (field.name === "commentEdge") {
      const wrapped = value as { comment: Comment };
      out[key] = gqlSelect(ctx, "CommentEdge", wrapped.comment, field.selections);
    } else if (field.name === "clientMutationId") {
      out[key] = null;
    } else {
      out[key] = null;
    }
  }
  void typeName;
  return out;
}

export function handleGraphQL(state: ForgeState, body: Buffer): HttpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return jsonResponse(400, { message: "invalid JSON body" });
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results: Record<string, unknown>[] = [];
  for (const req of requests) {
    const doc = (req as Record<string, unknown>).query;
    const variables = ((req as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    if (typeof doc !== "string") {
      results.push({ data: null, errors: [{ message: "query is required" }] });
      continue;
    }
    let ops: GqlOperation[];
    try {
      ops = new GqlParser(gqlTokenize(doc)).parseDocument();
    } catch (e) {
      results.push({ data: null, errors: [{ message: (e as Error).message }] });
      continue;
    }
    const ctx: GqlContext = { state, errors: [], variables };
    const data: Record<string, unknown> = {};
    for (const op of ops) {
      if (op.type === "mutation") {
        Object.assign(data, gqlExecuteMutation(ctx, op, variables));
      } else {
        for (const field of op.selections) {
          const key = field.alias ?? field.name;
          // Root query fields resolve through the Query type.
          const args: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(field.args)) args[k] = gqlResolveValue(v, variables);
          const fakeField: GqlField = { ...field, args: {} };
          // Re-resolve args with variables applied.
          const resolved = gqlResolveFieldWithArgs(ctx, "Query", null, fakeField, args);
          data[key] = resolved;
        }
      }
    }
    // Mutation payloads are selected inside gqlExecuteMutation via
    // gqlSelectPayload.
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    results.push(result);
  }
  return jsonResponse(200, Array.isArray(parsed) ? results : results[0]);
}

function gqlResolveFieldWithArgs(
  ctx: GqlContext,
  typeName: string,
  value: unknown,
  field: GqlField,
  args: Record<string, unknown>,
): unknown {
  // Thin wrapper: temporarily swap the field's args so gqlResolveField sees
  // the variable-resolved values.
  const saved = field.args;
  const asValues: Record<string, GqlValue> = {};
  for (const [k, v] of Object.entries(args)) {
    asValues[k] = { kind: "string", value: v };
    if (typeof v === "number") asValues[k] = { kind: "int", value: v };
    if (typeof v === "boolean") asValues[k] = { kind: "boolean", value: v };
    if (v === null) asValues[k] = { kind: "null", value: null };
    if (Array.isArray(v)) asValues[k] = { kind: "list", items: v.map((x) => ({ kind: "string", value: String(x) })) };
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      asValues[k] = {
        kind: "object",
        fields: Object.entries(v as Record<string, unknown>).map(([fk, fv]) => ({
          name: fk,
          value: { kind: "string", value: String(fv) } as GqlValue,
        })),
      };
    }
  }
  field.args = asValues;
  const out = gqlResolveField(ctx, typeName, value, field);
  field.args = saved;
  return out;
}

// ------------------------------------------------------------ MCP

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: "create_repo",
    description: "Create a repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        private: { type: "boolean", description: "Whether the repository is private" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_repo",
    description: "Get a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", description: "open, closed or all" },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        head: { type: "string", description: "Head branch name" },
        base: { type: "string", description: "Base branch name" },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
  },
  {
    name: "merge_pull_request",
    description: "Merge a pull request.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        pull_number: { type: "integer", description: "Pull request number" },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
];

const MCP_TOOLS_LIST_JSON = JSON.stringify({ tools: MCP_TOOLS });

function mcpToolOk(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: "text", text }], structuredContent: obj };
}

function mcpToolError(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError: true };
}

function mcpCallTool(
  state: ForgeState,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { __rpcError: { code: -32602, message: `unknown tool ${name}` } };
  const schema = tool.inputSchema as { required?: string[] };
  for (const req of schema.required ?? []) {
    if (args[req] === undefined || args[req] === null) {
      return mcpToolError(`missing required argument: ${req}`);
    }
  }
  if (name === "create_repo") {
    const repoName = String(args.name);
    if (state.repos.has(repoKey(VIEWER_LOGIN, repoName))) {
      return mcpToolError(`repository ${repoName} already exists`);
    }
    const repo = createRepoRecord(
      state,
      repoName,
      typeof args.description === "string" ? args.description : "",
      args.private === true,
    );
    return mcpToolOk(repoToJson(repo));
  }
  if (name === "get_repo") {
    const repo = getRepo(state, String(args.owner), String(args.repo));
    if (!repo) return mcpToolError("repository not found");
    return mcpToolOk(repoToJson(repo));
  }
  if (name === "create_issue") {
    const repo = getRepo(state, String(args.owner), String(args.repo));
    if (!repo) return mcpToolError("repository not found");
    const issue = createIssueRecord(
      state,
      repo,
      String(args.title),
      typeof args.body === "string" ? args.body : "",
      [],
    );
    return mcpToolOk(issueToJson(repo, issue));
  }
  if (name === "list_issues") {
    const repo = getRepo(state, String(args.owner), String(args.repo));
    if (!repo) return mcpToolError("repository not found");
    const stateFilter = typeof args.state === "string" ? args.state : "open";
    let list = [...repo.issues.values()];
    if (stateFilter !== "all") list = list.filter((i) => i.state === stateFilter);
    list.sort((a, b) => a.seq - b.seq);
    return mcpToolOk(list.map((i) => issueToJson(repo, i)));
  }
  if (name === "create_pull_request") {
    const repo = getRepo(state, String(args.owner), String(args.repo));
    if (!repo) return mcpToolError("repository not found");
    const { pull, error } = createPullRecord(
      state,
      repo,
      String(args.title),
      typeof args.body === "string" ? args.body : "",
      String(args.head),
      String(args.base),
    );
    if (error || !pull) return mcpToolError(error ?? "failed to create pull request");
    return mcpToolOk(pullToJson(repo, pull));
  }
  if (name === "merge_pull_request") {
    const repo = getRepo(state, String(args.owner), String(args.repo));
    if (!repo) return mcpToolError("repository not found");
    const num = Number(args.pull_number);
    const pull = repo.pulls.get(num);
    if (!pull) return mcpToolError("pull request not found");
    if (pull.merged) return mcpToolOk({ merged: true, sha: pull.mergeCommitSha, message: "already merged" });
    if (pullMergeable(repo, pull) !== "MERGEABLE") return mcpToolError("merge conflict");
    const sha = squashMergePull(repo, pull);
    if (!sha) return mcpToolError("merge conflict");
    return mcpToolOk({ merged: true, sha, message: `${pull.title} (#${pull.number})` });
  }
  return mcpToolError(`tool ${name} is not implemented`);
}

export function handleMcp(state: ForgeState, req: HttpRequest): HttpResponse {
  if (req.method === "DELETE") {
    return { status: 200, headers: {}, body: null };
  }
  if (req.method !== "POST") {
    return errorJson(405, "method not allowed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString("utf8"));
  } catch {
    return jsonResponse(400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error" },
    });
  }
  const msg = parsed as Record<string, unknown>;
  // Notification (no id): accept silently.
  if (msg.id === undefined || msg.id === null) {
    return { status: 202, headers: {}, body: null };
  }
  const id = msg.id as string | number;
  const method = typeof msg.method === "string" ? msg.method : "";
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown): HttpResponse =>
    jsonResponse(200, { jsonrpc: "2.0", id, result });
  const err = (code: number, message: string): HttpResponse =>
    jsonResponse(200, { jsonrpc: "2.0", id, error: { code, message } });

  if (method === "server/discover") {
    return ok({
      supportedVersions: ["2026-07-28", "2025-11-25"],
      serverInfo: { name: AGENT_NAME, version: "3.0.0" },
      capabilities: { tools: {} },
    });
  }
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
    return ok({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: AGENT_NAME, version: "3.0.0" },
    });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") {
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, result: JSON.parse(MCP_TOOLS_LIST_JSON) }) };
  }
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = mcpCallTool(state, name, args);
    if ("__rpcError" in result) {
      const e = result.__rpcError as { code: number; message: string };
      return err(e.code, e.message);
    }
    return ok(result);
  }
  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return { status: 202, headers: {}, body: null };
  }
  return err(-32601, `method not found: ${method}`);
}

// ------------------------------------------------------------ server

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { Readable } from "node:stream";

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      // Small bodies (the bench's issue/pack posts) usually arrive as one
      // chunk: return it directly instead of copying via Buffer.concat.
      if (chunks.length === 1) resolve(chunks[0]);
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendHttp(res: ServerResponse, state: ForgeState, response: HttpResponse): void {
  const headers: Record<string, string> = {
    "x-github-request-id": requestId(state),
    ...response.headers,
  };
  const body = response.body;
  if (body === null || body === undefined) {
    res.writeHead(response.status, headers);
    res.end();
    return;
  }
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  headers["content-length"] = String(buf.length);
  res.writeHead(response.status, headers);
  res.end(buf);
}

function sendRaw(res: ServerResponse, state: ForgeState, status: number, contentType: string, body: Buffer): void {
  const t0 = PROF_ON ? process.hrtime.bigint() : 0n;
  const headers: Record<string, string> = {
    "x-github-request-id": requestId(state),
    "content-type": contentType,
    "content-length": String(body.length),
  };
  res.writeHead(status, headers);
  res.end(body);
  if (PROF_ON) profAdd("http.sendRaw", Number(process.hrtime.bigint() - t0));
}

/** Parse the bench's hot issue paths without splitting or decoding:
 *  /api/v3/repos/<owner>/<repo>/issues or .../issues/<digits>.
 *  Returns null for any other shape. */
function fastIssueRoute(path: string): { owner: string; repoName: string; number: number | null } | null {
  const PREFIX = "/api/v3/repos/";
  if (!path.startsWith(PREFIX)) return null;
  const rest = path.slice(PREFIX.length);
  const s1 = rest.indexOf("/");
  if (s1 <= 0) return null;
  const owner = rest.slice(0, s1);
  const s2 = rest.indexOf("/", s1 + 1);
  if (s2 < 0) return null;
  const repoName = rest.slice(s1 + 1, s2);
  if (!repoName) return null;
  const tail = rest.slice(s2 + 1);
  if (tail === "issues") return { owner, repoName, number: null };
  if (!tail.startsWith("issues/")) return null;
  const numText = tail.slice("issues/".length);
  if (!numText || !/^[0-9]+$/.test(numText)) return null;
  const number = parseInt(numText, 10);
  if (!Number.isSafeInteger(number)) return null;
  return { owner, repoName, number };
}

/** Read `?service=<v>` from a raw query string without URLSearchParams. */
function queryService(query: string): string {
  const key = "service=";
  let i = query.indexOf(key);
  while (i >= 0) {
    if (i === 0 || query[i - 1] === "&") {
      const end = query.indexOf("&", i + key.length);
      return end < 0 ? query.slice(i + key.length) : query.slice(i + key.length, end);
    }
    i = query.indexOf(key, i + 1);
  }
  return "";
}

export async function handleRequest(state: ForgeState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const rawUrl = req.url ?? "/";
    const qIndex = rawUrl.indexOf("?");
    const path = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const query = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : "";
    const method = req.method ?? "GET";

    // Health probe: no auth, always 200.
    if (path === "/healthz" && method === "GET") {
      sendHttp(res, state, jsonResponse(200, { ok: true }));
      return;
    }

    // Auth for everything else. Node already lowercases header names, so
    // the hot fast path below reads req.headers directly; the copied headers
    // object is only built for the generic router further down.
    const auth = req.headers.authorization;
    const authOk = typeof auth === "string" && auth === state.authHeader;
    if (!authOk) {
      sendHttp(res, state, errorJson(401, "unauthorized"));
      return;
    }

    const body = method === "GET" || method === "HEAD" ? Buffer.alloc(0) : await (async () => {
      const b0 = PROF_ON ? process.hrtime.bigint() : 0n;
      const b = await readBody(req);
      if (PROF_ON) profAdd("http.readBody", Number(process.hrtime.bigint() - b0));
      return b;
    })();

    // Fast path: GET / POST a single issue (the bench's hot shapes).
    // Exact segment match, no query string, no percent-escapes — anything
    // else falls through to the generic router below, which stays the
    // behaviour for every other request.
    if (query === "" && !path.includes("%") && (method === "GET" || method === "POST")) {
      const fast = fastIssueRoute(path);
      if (fast) {
        const repo = getRepo(state, fast.owner, fast.repoName);
        if (repo) {
          if (method === "GET" && fast.number !== null) {
            const issue = repo.issues.get(fast.number);
            if (issue) {
              const g0 = PROF_ON ? process.hrtime.bigint() : 0n;
              sendRaw(res, state, 200, "application/json", issueJsonBuffer(repo, issue));
              if (PROF_ON) {
                profAdd("http.getIssue", Number(process.hrtime.bigint() - g0));
                profInc("count.getIssue");
              }
              return;
            }
          } else if (method === "POST" && fast.number === null) {
            const p0 = PROF_ON ? process.hrtime.bigint() : 0n;
            const parsed = parseJsonBody(body);
            if (parsed.ok) {
              const pbody = (parsed.value ?? {}) as Record<string, unknown>;
              const title = typeof pbody.title === "string" ? pbody.title : "";
              if (title) {
                const labels = Array.isArray(pbody.labels)
                  ? (pbody.labels as unknown[]).map((l) => String(l))
                  : [];
                let labelsOk = true;
                for (const l of labels) {
                  if (!repo.labels.has(l)) {
                    labelsOk = false;
                    break;
                  }
                }
                if (labelsOk) {
                  const issue = createIssueRecord(state, repo, title, typeof pbody.body === "string" ? pbody.body : "", labels);
                  sendRaw(res, state, 201, "application/json", issueJsonBuffer(repo, issue));
                  if (PROF_ON) {
                    profAdd("http.postIssue", Number(process.hrtime.bigint() - p0));
                    profInc("count.postIssue");
                  }
                  return;
                }
              }
            }
          }
        }
      }
    }

    // Git smart HTTP: /{owner}/{repo}.git/... — handled before the headers
    // copy below: git requests are the bench's hot shapes (push/clone) and
    // only need req.headers (Node already lowercases names) + the query
    // string, so the Object.entries copy is skipped for them entirely.
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      const tail = gitMatch[3];
      const repo = getRepo(state, owner, repoName);
      if (!repo) {
        sendHttp(res, state, errorJson(404, "not found"));
        return;
      }
      if (tail === "info/refs" && method === "GET") {
        const r0 = PROF_ON ? process.hrtime.bigint() : 0n;
        const service = queryService(query);
        const gp = req.headers["git-protocol"];
        const wantsV2 = gp === "version=2" || String(gp ?? "").includes("version=2");
        if (service === "git-upload-pack") {
          if (wantsV2) {
            sendRaw(res, state, 200, "application/x-git-upload-pack-advertisement", V2_ADVERTISEMENT);
          } else {
            sendRaw(res, state, 200, "application/x-git-upload-pack-advertisement", advertisementV0(repo, "git-upload-pack"));
          }
          if (PROF_ON) {
            profAdd("http.infoRefs", Number(process.hrtime.bigint() - r0));
            profInc("count.infoRefs");
          }
          return;
        }
        if (service === "git-receive-pack") {
          sendRaw(res, state, 200, "application/x-git-receive-pack-advertisement", advertisementV0(repo, "git-receive-pack"));
          if (PROF_ON) {
            profAdd("http.infoRefs", Number(process.hrtime.bigint() - r0));
            profInc("count.infoRefs");
          }
          return;
        }
        sendHttp(res, state, errorJson(404, "not found"));
        return;
      }
      if (tail === "git-upload-pack" && method === "POST") {
        const u0 = PROF_ON ? process.hrtime.bigint() : 0n;
        let parsed: { packets: PktPacket[]; restOffset: number };
        try {
          parsed = parsePktLines(body);
        } catch (e) {
          sendHttp(res, state, errorJson(400, (e as Error).message));
          return;
        }
        const isV2 = (() => {
          const gp = req.headers["git-protocol"];
          return gp === "version=2" || String(gp ?? "").includes("version=2");
        })();
        const lines = pktLinesToText(parsed.packets);
        let fetchReq: FetchRequest;
        try {
          fetchReq = parseFetchRequest(lines, isV2);
        } catch (e) {
          sendHttp(res, state, errorJson(400, (e as Error).message));
          return;
        }
        let resp: Buffer;
        try {
          resp = handleFetch(repo, fetchReq);
        } catch (e) {
          sendHttp(res, state, errorJson(400, (e as Error).message));
          return;
        }
        sendRaw(res, state, 200, "application/x-git-upload-pack-result", resp);
        if (PROF_ON) {
          profAdd("http.uploadPack", Number(process.hrtime.bigint() - u0));
          profInc("count.uploadPack");
        }
        return;
      }
      if (tail === "git-receive-pack" && method === "POST") {
        const v0 = PROF_ON ? process.hrtime.bigint() : 0n;
        let commands: PushCommand[];
        let pack: Buffer;
        try {
          const parsedPush = parsePushRequest(body);
          commands = parsedPush.commands;
          pack = parsedPush.pack;
        } catch (e) {
          sendHttp(res, state, errorJson(400, (e as Error).message));
          return;
        }
        const results = applyPush(repo, commands, pack);
        sendRaw(res, state, 200, "application/x-git-receive-pack-result", pushReportBuffer(results));
        if (PROF_ON) {
          profAdd("http.receivePack", Number(process.hrtime.bigint() - v0));
          profInc("count.receivePack");
        }
        return;
      }
      sendHttp(res, state, errorJson(404, "not found"));
      return;
    }

    // Generic router: build the lowercased headers copy + HttpRequest here
    // (only REST/GraphQL/MCP reach this; git requests returned above).
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
    const httpReq: HttpRequest = { method, path, query, headers, body };

    // REST
    if (path === "/api/v3" || path.startsWith("/api/v3/")) {
      const response = handleRest(state, httpReq);
      sendHttp(res, state, response);
      return;
    }

    // GraphQL
    if (path === "/api/graphql") {
      if (method !== "POST") {
        sendHttp(res, state, errorJson(405, "method not allowed"));
        return;
      }
      sendHttp(res, state, handleGraphQL(state, body));
      return;
    }

    // MCP
    if (path === "/mcp") {
      sendHttp(res, state, handleMcp(state, httpReq));
      return;
    }

    sendHttp(res, state, errorJson(404, "not found"));
  } catch (e) {
    try {
      sendHttp(res, state, errorJson(500, (e as Error).message));
    } catch {
      // response already gone
    }
  }
}

export function createForge(token: string): Server {
  const state = createState(token);
  return createServer((req, res) => {
    void handleRequest(state, req, res);
  });
}

// ---------------------------------------------------------------------------
// v5 Phase B — raw TCP HTTP/1.1 server (node:net).
//
// node:http costs ~100+ µs/req on this box (IncomingMessage/ServerResponse
// allocation, its parser, writeHead/end validation, socket bookkeeping).
// The bench is thousands of tiny requests, so that overhead IS the read/write
// story. This server replaces only the TRANSPORT: requests are parsed
// incrementally from a per-socket buffer, run through the SAME handleRequest
// via a fake req/res shim, and the response is written with a single
// socket.write. Behaviour is identical to the node:http server — the only
// difference is how bytes get in and out.
//
// Techniques (not code) follow the standard minimal-epoll-server playbook:
// incremental parsing with slices into the read buffer (no string copies),
// zero-copy response assembly (one write of header+body), keep-alive +
// pipelining (leftover bytes after a request stay in the buffer), and
// backpressure via the drain event. Content-Length bodies only (the harness
// never sends chunked); chunked is answered 400.
// ---------------------------------------------------------------------------

/** Minimal ServerResponse stand-in: captures what sendHttp/sendRaw write. */
class FakeResponse {
  status = 200;
  headers: Record<string, string> = {};
  body: Buffer | null = null;
  ended = false;
  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }
  end(data?: Buffer | string): void {
    if (data === undefined || data === null) this.body = null;
    else if (typeof data === "string") this.body = Buffer.from(data, "utf8");
    else this.body = data;
    this.ended = true;
  }
}

function fakeRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): IncomingMessage {
  const req = Readable.from(body.length > 0 ? [body] : []) as unknown as IncomingMessage;
  (req as unknown as { url: string }).url = url;
  (req as unknown as { method: string }).method = method;
  (req as unknown as { headers: unknown }).headers = headers;
  return req;
}

const RAW_REASONS: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
};

function serializeRawResponse(method: string, res: FakeResponse, keepAlive: boolean): Buffer {
  const body = method === "HEAD" ? null : res.body;
  const parts: string[] = [`HTTP/1.1 ${res.status} ${RAW_REASONS[res.status] ?? "Status"}\r\n`];
  let hasLength = false;
  for (const [k, v] of Object.entries(res.headers)) {
    if (k.toLowerCase() === "content-length") hasLength = true;
    parts.push(`${k}: ${v}\r\n`);
  }
  if (!hasLength && body) parts.push(`content-length: ${body.length}\r\n`);
  parts.push(`connection: ${keepAlive ? "keep-alive" : "close"}\r\n\r\n`);
  const headBuf = Buffer.from(parts.join(""), "ascii");
  if (!body) return headBuf;
  return Buffer.concat([headBuf, body]);
}

const MAX_RAW_HEAD = 64 * 1024;
const MAX_RAW_BODY = 64 * 1024 * 1024;

interface RawParsed {
  method: string;
  target: string;
  headers: Record<string, string>;
  keepAlive: boolean;
  body: Buffer;
  consumed: number;
}

/**
 * Parse one complete request from buf, or null if more bytes are needed.
 * Throws on a malformed request. The returned body is a view into buf
 * (no copy); it is consumed synchronously by handleRequest before buf moves.
 */
function parseRawRequest(buf: Buffer): RawParsed | null {
  const headEnd = buf.indexOf("\r\n\r\n");
  if (headEnd < 0) {
    if (buf.length > MAX_RAW_HEAD) throw new Error("request head too large");
    return null;
  }
  const head = buf.subarray(0, headEnd).toString("ascii");
  const lines = head.split("\r\n");
  const first = lines[0];
  const sp1 = first.indexOf(" ");
  const sp2 = first.indexOf(" ", sp1 + 1);
  if (sp1 <= 0 || sp2 <= sp1 + 1) throw new Error("bad request line");
  const method = first.slice(0, sp1);
  const target = first.slice(sp1 + 1, sp2);
  const version = first.slice(sp2 + 1);
  if (!version.startsWith("HTTP/")) throw new Error("bad http version");
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error("bad header line");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers[name];
    headers[name] = prev === undefined ? value : `${prev}, ${value}`;
  }
  const te = headers["transfer-encoding"];
  if (te && te.toLowerCase() !== "identity") throw new Error("chunked request bodies are not supported");
  const cl = headers["content-length"];
  let contentLength = 0;
  if (cl !== undefined) {
    contentLength = Number(cl);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error("bad content-length");
    if (contentLength > MAX_RAW_BODY) throw new Error("request body too large");
  }
  const bodyStart = headEnd + 4;
  if (buf.length < bodyStart + contentLength) return null;
  const body = contentLength > 0 ? buf.subarray(bodyStart, bodyStart + contentLength) : Buffer.alloc(0);
  const conn = headers["connection"];
  const keepAlive = conn ? conn.toLowerCase() !== "close" : version !== "HTTP/1.0";
  return { method, target, headers, keepAlive, body, consumed: bodyStart + contentLength };
}

function serveRawConnection(socket: Socket, state: ForgeState): void {
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let busy = false;
  let closed = false;
  const pump = async (): Promise<void> => {
    if (busy || closed) return;
    busy = true;
    try {
      for (;;) {
        let req: RawParsed | null;
        try {
          req = parseRawRequest(buf);
        } catch {
          socket.write(
            Buffer.from("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n", "ascii"),
          );
          socket.end();
          closed = true;
          return;
        }
        if (!req) break;
        buf = buf.subarray(req.consumed);
        const fakeReq = fakeRequest(req.method, req.target, req.headers, req.body);
        const fakeRes = new FakeResponse();
        try {
          await handleRequest(state, fakeReq as unknown as IncomingMessage, fakeRes as unknown as ServerResponse);
        } catch {
          if (!fakeRes.ended) {
            fakeRes.writeHead(500, { "content-type": "application/json" });
            fakeRes.end(Buffer.from('{"error":"internal error"}', "utf8"));
          }
        }
        if (!fakeRes.ended) {
          fakeRes.writeHead(404, { "content-type": "application/json" });
          fakeRes.end(Buffer.from('{"error":"not found"}', "utf8"));
        }
        const out = serializeRawResponse(req.method, fakeRes, req.keepAlive);
        const ok = socket.write(out);
        if (!ok) {
          await new Promise<void>((resolve) => {
            socket.once("drain", () => resolve());
            socket.once("close", () => resolve());
            socket.once("error", () => resolve());
          });
        }
        if (!req.keepAlive) {
          socket.end();
          closed = true;
          return;
        }
        if (closed) return;
      }
    } finally {
      busy = false;
    }
  };
  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    void pump();
  });
  socket.on("error", () => {
    closed = true;
    socket.destroy();
  });
  socket.on("close", () => {
    closed = true;
  });
  socket.setTimeout(120_000, () => {
    closed = true;
    socket.destroy();
  });
}

export function createRawForge(token: string): NetServer {
  const state = createState(token);
  const server = createNetServer((socket) => {
    serveRawConnection(socket, state);
  });
  return server;
}
