// Git objects: trees, commits, tags, and packfiles (v2/v3, deltas).
// Written fresh in Go for the v6 native core; behaviour mirrors the
// Node forge (app.ts) that passed 120/120 conformance.
package main

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"sort"
	"strings"
)

type gitObject struct {
	typ  string // "commit" | "tree" | "blob" | "tag"
	data []byte
}

type treeEntry struct {
	mode string
	name string
	oid  string
}

func parseTree(data []byte) ([]treeEntry, error) {
	var entries []treeEntry
	off := 0
	for off < len(data) {
		sp := bytes.IndexByte(data[off:], ' ')
		if sp < 0 {
			return nil, fmt.Errorf("tree entry has no mode separator")
		}
		sp += off
		nul := bytes.IndexByte(data[sp+1:], 0)
		if nul < 0 {
			return nil, fmt.Errorf("tree entry truncated")
		}
		nul += sp + 1
		if nul+21 > len(data) {
			return nil, fmt.Errorf("tree entry truncated")
		}
		entries = append(entries, treeEntry{
			mode: string(data[off:sp]),
			name: string(data[sp+1 : nul]),
			oid:  fmt.Sprintf("%x", data[nul+1:nul+21]),
		})
		off = nul + 21
	}
	return entries, nil
}

// compareTreeNames orders entries the way git does: directories sort as
// if their name had a trailing "/".
func compareTreeNames(a, b treeEntry) int {
	an := a.name
	if a.mode == "40000" {
		an += "/"
	}
	bn := b.name
	if b.mode == "40000" {
		bn += "/"
	}
	return bytes.Compare([]byte(an), []byte(bn))
}

func buildTree(entries []treeEntry) []byte {
	sorted := make([]treeEntry, len(entries))
	copy(sorted, entries)
	sort.SliceStable(sorted, func(i, j int) bool { return compareTreeNames(sorted[i], sorted[j]) < 0 })
	var buf bytes.Buffer
	for _, e := range sorted {
		fmt.Fprintf(&buf, "%s %s\x00", e.mode, e.name)
		raw, _ := hexDecode(e.oid)
		buf.Write(raw)
	}
	return buf.Bytes()
}

func hexDecode(s string) ([]byte, error) {
	return hex.DecodeString(s)
}

type commitParts struct {
	tree      string
	parents   []string
	author    string
	committer string
	message   string
}

func parseCommit(data []byte) commitParts {
	blank := bytes.Index(data, []byte("\n\n"))
	headEnd := len(data)
	if blank >= 0 {
		headEnd = blank
	}
	var message string
	if blank >= 0 {
		message = string(data[blank+2:])
	}
	out := commitParts{}
	off := 0
	for off < headEnd {
		nl := bytes.IndexByte(data[off:headEnd], '\n')
		lineEnd := headEnd
		if nl >= 0 {
			lineEnd = off + nl
		}
		sp := bytes.IndexByte(data[off:lineEnd], ' ')
		if sp < 0 {
			off = lineEnd + 1
			continue
		}
		sp += off
		key := string(data[off:sp])
		val := string(data[sp+1 : lineEnd])
		switch key {
		case "tree":
			out.tree = val
		case "parent":
			out.parents = append(out.parents, val)
		case "author":
			out.author = val
		case "committer":
			out.committer = val
		}
		off = lineEnd + 1
	}
	out.message = message
	return out
}

func buildCommit(tree string, parents []string, message string) []byte {
	ts := isoUnix()
	who := fmt.Sprintf("%s <%s> %d +0000", viewerName, viewerEmail, ts)
	var b strings.Builder
	fmt.Fprintf(&b, "tree %s\n", tree)
	for _, p := range parents {
		fmt.Fprintf(&b, "parent %s\n", p)
	}
	fmt.Fprintf(&b, "author %s\ncommitter %s\n\n%s", who, who, message)
	return []byte(b.String())
}

type tagParts struct {
	object  string
	typ     string
	tag     string
	tagger  string
	message string
}

func parseTag(data []byte) tagParts {
	blank := bytes.Index(data, []byte("\n\n"))
	headEnd := len(data)
	if blank >= 0 {
		headEnd = blank
	}
	out := tagParts{}
	for _, line := range bytes.Split(data[:headEnd], []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		sp := bytes.IndexByte(line, ' ')
		if sp < 0 {
			continue
		}
		switch string(line[:sp]) {
		case "object":
			out.object = string(line[sp+1:])
		case "type":
			out.typ = string(line[sp+1:])
		case "tag":
			out.tag = string(line[sp+1:])
		case "tagger":
			out.tagger = string(line[sp+1:])
		}
	}
	if blank >= 0 {
		out.message = string(data[blank+2:])
	}
	return out
}

// ------------------------------------------------------------ packs

var typeCode = map[string]int{"commit": 1, "tree": 2, "blob": 3, "tag": 4}
var codeType = map[int]string{1: "commit", 2: "tree", 3: "blob", 4: "tag"}

func writePackObjectHeader(typ string, size int) []byte {
	code := typeCode[typ]
	var out []byte
	remaining := size
	first := byte((code << 4) | (remaining & 15))
	remaining >>= 4
	for remaining > 0 {
		out = append(out, first|0x80)
		first = byte(remaining & 127)
		remaining >>= 7
	}
	out = append(out, first)
	return out
}

func deflate(data []byte) []byte {
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	w.Write(data)
	w.Close()
	return buf.Bytes()
}

// writePack builds a pack (v2, no deltas) from objects, deterministic
// order by oid. objs maps oid -> object.
func writePack(objs map[string]*gitObject) []byte {
	type ent struct {
		oid  string
		typ  string
		data []byte
	}
	list := make([]ent, 0, len(objs))
	for oid, o := range objs {
		list = append(list, ent{oid, o.typ, o.data})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].oid < list[j].oid })
	var body bytes.Buffer
	hdr := make([]byte, 12)
	copy(hdr, "PACK")
	binary.BigEndian.PutUint32(hdr[4:], 2)
	binary.BigEndian.PutUint32(hdr[8:], uint32(len(list)))
	body.Write(hdr)
	for _, o := range list {
		body.Write(writePackObjectHeader(o.typ, len(o.data)))
		body.Write(deflate(o.data))
	}
	out := body.Bytes()
	trailer := sha1Sum(out)
	return append(out, trailer...)
}

func sha1Sum(data []byte) []byte {
	sum := sha1.Sum(data)
	return sum[:]
}

// readVarintSize reads a pack entry's type+size varint.
func readVarintSize(buf []byte, start int) (size int, next int, first byte, err error) {
	if start >= len(buf) {
		return 0, 0, 0, fmt.Errorf("pack entry has no size header")
	}
	b := buf[start]
	first = b
	size = int(b & 15)
	shift := uint(4)
	off := start + 1
	for b&0x80 != 0 {
		if off >= len(buf) {
			return 0, 0, 0, fmt.Errorf("pack entry size varint truncated")
		}
		b = buf[off]
		off++
		size += int(b&127) << shift
		shift += 7
		if shift > 63 {
			return 0, 0, 0, fmt.Errorf("pack size varint too long")
		}
	}
	return size, off, first, nil
}

func readOfsDeltaBase(buf []byte, start int) (baseOffset int, next int, err error) {
	if start >= len(buf) {
		return 0, 0, fmt.Errorf("ofs-delta has no base offset")
	}
	b := buf[start]
	off := start + 1
	value := int(b & 127)
	for b&0x80 != 0 {
		if off >= len(buf) {
			return 0, 0, fmt.Errorf("ofs-delta base offset truncated")
		}
		b = buf[off]
		off++
		value = (value+1)*128 + int(b&127)
	}
	return value, off, nil
}

// inflateAt inflates one zlib stream starting at offset; returns the data
// and the offset just past the consumed stream bytes. The counting reader
// returns at most one byte per Read: flate buffers up to 512 bytes from its
// input, so an unbounded reader would over-count the stream's length and
// corrupt the next pack entry's offset.
func inflateAt(buf []byte, offset, end int) ([]byte, int, error) {
	cr := &countReader{r: bytes.NewReader(buf[offset:end])}
	zr, err := zlib.NewReader(cr)
	if err != nil {
		return nil, 0, fmt.Errorf("zlib stream at offset %d did not inflate: %v", offset, err)
	}
	data, err := io.ReadAll(zr)
	zr.Close()
	if err != nil {
		return nil, 0, fmt.Errorf("zlib stream at offset %d did not inflate: %v", offset, err)
	}
	return data, offset + cr.n, nil
}

type countReader struct {
	r io.Reader
	n int
}

// Read returns at most one byte: this keeps flate from reading past the
// end of the zlib stream into the next pack entry.
func (c *countReader) Read(p []byte) (int, error) {
	if len(p) > 1 {
		p = p[:1]
	}
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

func applyDelta(base, delta []byte) ([]byte, error) {
	off := 0
	readSize := func() (int, error) {
		value := 0
		shift := uint(0)
		for {
			if off >= len(delta) {
				return 0, fmt.Errorf("delta size varint truncated")
			}
			b := delta[off]
			off++
			value += int(b&127) << shift
			shift += 7
			if b&0x80 == 0 {
				break
			}
			if shift > 63 {
				return 0, fmt.Errorf("delta size varint too long")
			}
		}
		return value, nil
	}
	sourceSize, err := readSize()
	if err != nil {
		return nil, err
	}
	targetSize, err := readSize()
	if err != nil {
		return nil, err
	}
	if sourceSize != len(base) {
		return nil, fmt.Errorf("delta expects a %d-byte base, got %d", sourceSize, len(base))
	}
	out := make([]byte, targetSize)
	written := 0
	for off < len(delta) {
		op := delta[off]
		off++
		if op&0x80 != 0 {
			copyOffset := 0
			copySize := 0
			shift := uint(0)
			for bit := 0; bit < 4; bit++ {
				if op&(1<<bit) != 0 {
					if off >= len(delta) {
						return nil, fmt.Errorf("delta copy offset truncated")
					}
					copyOffset += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			shift = 0
			for bit := 4; bit < 7; bit++ {
				if op&(1<<bit) != 0 {
					if off >= len(delta) {
						return nil, fmt.Errorf("delta copy size truncated")
					}
					copySize += int(delta[off]) << shift
					off++
				}
				shift += 8
			}
			if copySize == 0 {
				copySize = 65536
			}
			if copyOffset+copySize > len(base) {
				return nil, fmt.Errorf("delta copy out of base")
			}
			if written+copySize > targetSize {
				return nil, fmt.Errorf("delta writes past target")
			}
			copy(out[written:written+copySize], base[copyOffset:copyOffset+copySize])
			written += copySize
		} else if op != 0 {
			lit := int(op & 127)
			if off+lit > len(delta) {
				return nil, fmt.Errorf("delta insert truncated")
			}
			if written+lit > targetSize {
				return nil, fmt.Errorf("delta writes past target")
			}
			copy(out[written:written+lit], delta[off:off+lit])
			off += lit
			written += lit
		} else {
			return nil, fmt.Errorf("delta opcode 0 invalid")
		}
	}
	if written != targetSize {
		return nil, fmt.Errorf("delta produced %d of %d bytes", written, targetSize)
	}
	return out, nil
}

type readPackResult struct {
	objects    map[string]*gitObject
	deltaCount int
	checksumOK bool
}

type rawEntry struct {
	offset     int
	typeCode   int
	size       int
	data       []byte
	baseOffset int // ofs-delta: absolute offset of base
	baseOID    string
	hasBase    bool
	resolved   *resolvedObj
}

type resolvedObj struct {
	typ  string
	data []byte
	oid  string
}

// readPack parses a pack (v2/v3, ofs/ref deltas). resolveBase supplies
// objects the pack's deltas need that are not in the pack (thin packs).
func readPack(pack []byte, resolveBase func(oid string) *gitObject) (*readPackResult, error) {
	if len(pack) < 32 {
		return nil, fmt.Errorf("pack is %d bytes, too short", len(pack))
	}
	if string(pack[0:4]) != "PACK" {
		return nil, fmt.Errorf("pack does not start with PACK")
	}
	version := binary.BigEndian.Uint32(pack[4:8])
	if version != 2 && version != 3 {
		return nil, fmt.Errorf("unsupported pack version %d", version)
	}
	declaredCount := binary.BigEndian.Uint32(pack[8:12])
	trailerStart := len(pack) - 20
	trailer := fmt.Sprintf("%x", pack[trailerStart:])
	computed := sha1Hex(pack[:trailerStart])
	checksumOK := trailer == computed
	if !checksumOK {
		return nil, fmt.Errorf("pack trailer checksum mismatch")
	}
	raw := make([]*rawEntry, 0, declaredCount)
	byOffset := make(map[int]*rawEntry)
	offset := 12
	for i := uint32(0); i < declaredCount; i++ {
		entryOffset := offset
		size, next, first, err := readVarintSize(pack, offset)
		if err != nil {
			return nil, err
		}
		offset = next
		tc := int((first >> 4) & 7)
		entry := &rawEntry{offset: entryOffset, typeCode: tc, size: size}
		if tc == 6 {
			base, next2, err := readOfsDeltaBase(pack, offset)
			if err != nil {
				return nil, err
			}
			offset = next2
			if base <= 0 || base > entryOffset {
				return nil, fmt.Errorf("ofs-delta at %d names invalid base offset %d", entryOffset, base)
			}
			entry.baseOffset = entryOffset - base
			entry.hasBase = true
		} else if tc == 7 {
			if offset+20 > trailerStart {
				return nil, fmt.Errorf("ref-delta base id truncated")
			}
			entry.baseOID = fmt.Sprintf("%x", pack[offset:offset+20])
			offset += 20
			entry.hasBase = true
		} else if codeType[tc] == "" {
			return nil, fmt.Errorf("pack entry %d has unknown type code %d", i, tc)
		}
		data, nextOff, err := inflateAt(pack, offset, trailerStart)
		if err != nil {
			return nil, err
		}
		if len(data) != size {
			return nil, fmt.Errorf("pack entry at %d declares %d bytes but inflated to %d", entryOffset, size, len(data))
		}
		entry.data = data
		offset = nextOff
		raw = append(raw, entry)
		byOffset[entryOffset] = entry
	}
	if offset != trailerStart {
		return nil, fmt.Errorf("pack has %d stray bytes before trailer", trailerStart-offset)
	}
	objects := make(map[string]*gitObject)
	resolvedByOID := make(map[string]*rawEntry)
	resolving := make(map[int]bool)
	deltaCount := 0
	var resolve func(e *rawEntry) (*resolvedObj, error)
	resolve = func(e *rawEntry) (*resolvedObj, error) {
		if e.resolved != nil {
			return e.resolved, nil
		}
		if resolving[e.offset] {
			return nil, fmt.Errorf("delta cycle at pack offset %d", e.offset)
		}
		resolving[e.offset] = true
		var typ string
		var data []byte
		if e.typeCode == 6 {
			baseEntry := byOffset[e.baseOffset]
			if baseEntry == nil {
				return nil, fmt.Errorf("ofs-delta base at offset %d not in pack", e.baseOffset)
			}
			base, err := resolve(baseEntry)
			if err != nil {
				return nil, err
			}
			typ = base.typ
			data, err = applyDelta(base.data, e.data)
			if err != nil {
				return nil, err
			}
		} else if e.typeCode == 7 {
			if inPack, ok := resolvedByOID[e.baseOID]; ok {
				base, err := resolve(inPack)
				if err != nil {
					return nil, err
				}
				typ = base.typ
				data, err = applyDelta(base.data, e.data)
				if err != nil {
					return nil, err
				}
			} else {
				var external *gitObject
				if resolveBase != nil {
					external = resolveBase(e.baseOID)
				}
				if external == nil {
					return nil, fmt.Errorf("ref-delta base %s neither in pack nor supplied", e.baseOID)
				}
				typ = external.typ
				var err error
				data, err = applyDelta(external.data, e.data)
				if err != nil {
					return nil, err
				}
			}
		} else {
			typ = codeType[e.typeCode]
			data = e.data
		}
		oid := hashObject(typ, data)
		out := &resolvedObj{typ: typ, data: data, oid: oid}
		e.resolved = out
		resolvedByOID[oid] = e
		delete(resolving, e.offset)
		return out, nil
	}
	for _, entry := range raw {
		r, err := resolve(entry)
		if err != nil {
			return nil, err
		}
		if entry.typeCode == 6 || entry.typeCode == 7 {
			deltaCount++
		}
		if _, ok := objects[r.oid]; !ok {
			objects[r.oid] = &gitObject{typ: r.typ, data: r.data}
		}
	}
	return &readPackResult{objects: objects, deltaCount: deltaCount, checksumOK: checksumOK}, nil
}
