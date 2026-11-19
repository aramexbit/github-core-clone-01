package main

// Microbenchmark + correctness guard for readPack (Stage 4).
// benchPack3 mirrors the harness push pack: 1 KiB blob + tree + commit,
// no deltas. The delta tests guard the ofs/ref/thin-ref resolution paths
// that the alloc trim touches (byOffset scan, lazy resolvedByOID,
// resolving flag on the entry).

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"testing"
)

func benchPack3() []byte {
	blob := bytes.Repeat([]byte("x"), 1024)
	blobOID := hashObject("blob", blob)
	raw, _ := hex.DecodeString(blobOID)
	treeData := append([]byte("100644 file.txt\x00"), raw...)
	treeOID := hashObject("tree", treeData)
	commitData := []byte("tree " + treeOID + "\nauthor A <a@b> 1700000000 +0000\ncommitter A <a@b> 1700000000 +0000\n\ninit\n")
	commitOID := hashObject("commit", commitData)
	return writePack(map[string]*gitObject{
		blobOID:   {typ: "blob", data: blob},
		treeOID:   {typ: "tree", data: treeData},
		commitOID: {typ: "commit", data: commitData},
	})
}

func BenchmarkReadPack3(b *testing.B) {
	pack := benchPack3()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		res, err := readPack(pack, nil)
		if err != nil {
			b.Fatal(err)
		}
		if len(res.objects) != 3 || !res.checksumOK {
			b.Fatal("bad result")
		}
	}
}

// --- delta pack construction (insert-only deltas: exercises resolution,
// not copy-op decoding) ---

func packVarintHeader(typeCode, size int) []byte {
	var out []byte
	first := byte((typeCode << 4) | (size & 15))
	size >>= 4
	for size > 0 {
		out = append(out, first|0x80)
		first = byte(size & 127)
		size >>= 7
	}
	out = append(out, first)
	return out
}

func deltaVarint(n int) []byte {
	var out []byte
	for {
		c := byte(n & 127)
		n >>= 7
		if n == 0 {
			out = append(out, c)
			return out
		}
		out = append(out, c|0x80)
	}
}

func deltaInsertOnly(src, target []byte) []byte {
	var d []byte
	d = append(d, deltaVarint(len(src))...)
	d = append(d, deltaVarint(len(target))...)
	for len(target) > 0 {
		n := len(target)
		if n > 127 {
			n = 127
		}
		d = append(d, byte(n))
		d = append(d, target[:n]...)
		target = target[n:]
	}
	return d
}

func encodeOfsDeltaOffset(v int) []byte {
	var rev []byte
	rev = append(rev, byte(v&0x7f))
	v >>= 7
	for v > 0 {
		v--
		rev = append(rev, byte(0x80|(v&0x7f)))
		v >>= 7
	}
	out := make([]byte, len(rev))
	for i, c := range rev {
		out[len(rev)-1-i] = c
	}
	return out
}

func buildPackWithDelta(t *testing.T, kind string) (pack []byte, baseOID, targetOID string, baseData, targetData []byte) {
	t.Helper()
	baseData = bytes.Repeat([]byte("abcdefgh"), 128) // 1024 bytes
	targetData = append([]byte{}, baseData...)
	copy(targetData[:16], []byte("0123456789abcdef"))
	baseOID = hashObject("blob", baseData)
	targetOID = hashObject("blob", targetData)
	delta := deltaInsertOnly(baseData, targetData)
	var body bytes.Buffer
	hdr := make([]byte, 12)
	copy(hdr, "PACK")
	binary.BigEndian.PutUint32(hdr[4:], 2)
	count := uint32(2)
	if kind == "thin-ref" {
		count = 1
	}
	binary.BigEndian.PutUint32(hdr[8:], count)
	body.Write(hdr)
	if kind != "thin-ref" {
		body.Write(packVarintHeader(3, len(baseData)))
		body.Write(deflate(baseData))
	}
	baseOffset := 12
	deltaEntryOffset := body.Len()
	if kind == "ofs" {
		body.Write(packVarintHeader(6, len(delta)))
		body.Write(encodeOfsDeltaOffset(deltaEntryOffset - baseOffset))
		body.Write(deflate(delta))
	} else {
		body.Write(packVarintHeader(7, len(delta)))
		raw, err := hex.DecodeString(baseOID)
		if err != nil {
			t.Fatal(err)
		}
		body.Write(raw)
		body.Write(deflate(delta))
	}
	out := body.Bytes()
	return append(out, sha1Sum(out)...), baseOID, targetOID, baseData, targetData
}

func TestReadPackDelta(t *testing.T) {
	for _, kind := range []string{"ofs", "ref"} {
		pack, baseOID, targetOID, baseData, targetData := buildPackWithDelta(t, kind)
		res, err := readPack(pack, nil)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if len(res.objects) != 2 {
			t.Fatalf("%s: want 2 objects, got %d", kind, len(res.objects))
		}
		if !res.checksumOK {
			t.Fatalf("%s: checksum", kind)
		}
		if res.deltaCount != 1 {
			t.Fatalf("%s: deltaCount=%d", kind, res.deltaCount)
		}
		tgt, ok := res.objects[targetOID]
		if !ok || tgt.typ != "blob" || !bytes.Equal(tgt.data, targetData) {
			t.Fatalf("%s: target wrong", kind)
		}
		base, ok := res.objects[baseOID]
		if !ok || !bytes.Equal(base.data, baseData) {
			t.Fatalf("%s: base wrong", kind)
		}
	}
	// Thin ref-delta: base outside the pack, supplied by resolveBase.
	pack, baseOID, targetOID, baseData, targetData := buildPackWithDelta(t, "thin-ref")
	res, err := readPack(pack, func(oid string) *gitObject {
		if oid == baseOID {
			return &gitObject{typ: "blob", data: baseData}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("thin-ref: %v", err)
	}
	if len(res.objects) != 1 {
		t.Fatalf("thin-ref: want 1 object, got %d", len(res.objects))
	}
	tgt := res.objects[targetOID]
	if tgt == nil || !bytes.Equal(tgt.data, targetData) {
		t.Fatalf("thin-ref: target wrong")
	}
}
