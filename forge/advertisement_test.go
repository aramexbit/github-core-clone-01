package main

// Guards advertisementV0's exact wire bytes: the info/refs advertisement
// is rebuilt on every push (cache invalidated), so any byte drift here
// breaks real git clients. Goldens are the output of the v7 Sprintf
// implementation, captured before the Stage-2 zero-alloc rewrite.

import (
	"bytes"
	"testing"
)

func advFixtureRepo() *repo {
	commitData := []byte("tree 0000000000000000000000000000000000000000\nauthor A <a@b> 1700000000 +0000\ncommitter A <a@b> 1700000000 +0000\n\ninit\n")
	commitOID := hashObject("commit", commitData)
	tagData := []byte("object " + commitOID + "\ntype commit\ntag v1\ntagger A <a@b> 1700000000 +0000\n\nv1\n")
	tagOID := hashObject("tag", tagData)
	return &repo{
		defaultBranch: "main",
		refs: map[string]string{
			"refs/heads/main": commitOID,
			"refs/tags/v1":    tagOID,
		},
		objects: map[string]*gitObject{
			commitOID: {typ: "commit", data: commitData},
			tagOID:    {typ: "tag", data: tagData},
		},
	}
}

var advGolden = map[string]string{
	"git-upload-pack":    "001e# service=git-upload-pack\n00000096c4c6cbb458d7dc37de4dff6f4ef9c6338bc8b1f6 HEAD\x00symref=HEAD:refs/heads/main side-band-64k ofs-delta agent=github-core-clone/3.0.0 shallow thin-pack\n003dc4c6cbb458d7dc37de4dff6f4ef9c6338bc8b1f6 refs/heads/main\n003a4b6b44b286910f7cc9e2fb7ce2269366e5847ddf refs/tags/v1\n003dc4c6cbb458d7dc37de4dff6f4ef9c6338bc8b1f6 refs/tags/v1^{}\n0000",
	"git-receive-pack":   "001f# service=git-receive-pack\n00000082c4c6cbb458d7dc37de4dff6f4ef9c6338bc8b1f6 HEAD\x00report-status side-band-64k delete-refs ofs-delta agent=github-core-clone/3.0.0\n003dc4c6cbb458d7dc37de4dff6f4ef9c6338bc8b1f6 refs/heads/main\n003a4b6b44b286910f7cc9e2fb7ce2269366e5847ddf refs/tags/v1\n0000",
}

func TestAdvertisementV0Golden(t *testing.T) {
	r := advFixtureRepo()
	for svc, want := range advGolden {
		out := r.advertisementV0(svc)
		if !bytes.Equal(out, []byte(want)) {
			t.Fatalf("%s: output differs from golden\n got: %q\nwant: %q", svc, out, want)
		}
		out2 := r.advertisementV0(svc) // cache hit must be identical
		if !bytes.Equal(out, out2) {
			t.Fatalf("%s: cache-hit bytes differ", svc)
		}
	}
}

func BenchmarkAdvertisementV0Miss(b *testing.B) {
	r := advFixtureRepo()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.advCache.Delete("git-upload-pack")
		_ = r.advertisementV0("git-upload-pack")
	}
}
