package main

// Microbenchmarks + correctness guard for parseHead (Stage 3).
// Heads mirror what the harness client (undici) sends: lowercase header
// names, keep-alive, accept + user-agent on every request.

import "testing"

var benchHeadGET = []byte("GET /api/v3/repos/acme/widgets/issues/42 HTTP/1.1\r\n" +
	"host: 127.0.0.1:18080\r\n" +
	"connection: keep-alive\r\n" +
	"accept: application/json\r\n" +
	"user-agent: undici\r\n")

var benchHeadPOST = []byte("POST /api/v3/repos/acme/widgets/issues HTTP/1.1\r\n" +
	"host: 127.0.0.1:18080\r\n" +
	"connection: keep-alive\r\n" +
	"content-type: application/json\r\n" +
	"content-length: 52\r\n" +
	"accept: application/json\r\n" +
	"user-agent: undici\r\n")

func TestParseHeadCases(t *testing.T) {
	req, cl, chunked, exp, ok := parseHead(benchHeadGET)
	if !ok || req == nil {
		t.Fatal("GET did not parse")
	}
	if req.method != "GET" || req.path != "/api/v3/repos/acme/widgets/issues/42" || req.query != "" {
		t.Fatalf("GET route wrong: %+v", req)
	}
	if req.host != "127.0.0.1:18080" || !req.version11 || !req.keepAlive {
		t.Fatalf("GET meta wrong: %+v", req)
	}
	if cl != -1 || chunked || exp {
		t.Fatalf("GET body flags wrong: cl=%d chunked=%v exp=%v", cl, chunked, exp)
	}
	if v, found := req.header("user-agent"); !found || v != "undici" {
		t.Fatalf("header lookup wrong: %q %v", v, found)
	}
	if v, found := req.header("connection"); !found || v != "keep-alive" {
		t.Fatalf("connection header wrong: %q %v", v, found)
	}

	req, cl, chunked, exp, ok = parseHead(benchHeadPOST)
	if !ok || req == nil || cl != 52 || chunked || exp {
		t.Fatalf("POST wrong: cl=%d chunked=%v exp=%v ok=%v", cl, chunked, exp, ok)
	}
	if v, found := req.header("content-type"); !found || v != "application/json" {
		t.Fatalf("content-type wrong: %q %v", v, found)
	}

	// Absolute-form target, HTTP/1.0 (keep-alive off by default).
	abs := []byte("GET http://127.0.0.1:18080/api/v3 HTTP/1.0\r\n" +
		"host: 127.0.0.1:18080\r\n")
	req, _, _, _, ok = parseHead(abs)
	if !ok || req.host != "127.0.0.1:18080" || req.path != "/api/v3" || req.version11 || req.keepAlive {
		t.Fatalf("absolute-form/1.0 wrong: %+v ok=%v", req, ok)
	}

	// Query string splits off the path.
	q := []byte("GET /api/v3/search/issues?q=bug&page=2 HTTP/1.1\r\nhost: h\r\n")
	req, _, _, _, ok = parseHead(q)
	if !ok || req.path != "/api/v3/search/issues" || req.query != "q=bug&page=2" {
		t.Fatalf("query split wrong: %+v ok=%v", req, ok)
	}

	// Mixed-case header names still match (stored lowercased).
	mixed := []byte("GET /x HTTP/1.1\r\nContent-Length: 3\r\nConnection: Close\r\n")
	req, cl, _, _, ok = parseHead(mixed)
	if !ok || cl != 3 || req.keepAlive {
		t.Fatalf("mixed-case wrong: cl=%d keepAlive=%v ok=%v", cl, req.keepAlive, ok)
	}
	if v, found := req.header("content-length"); !found || v != "3" {
		t.Fatalf("mixed-case lookup wrong: %q %v", v, found)
	}

	// Expect: 100-continue + chunked.
	ec := []byte("POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\nExpect: 100-continue\r\n")
	_, _, chunked, exp, ok = parseHead(ec)
	if !ok || !chunked || !exp {
		t.Fatalf("chunked/expect wrong: chunked=%v exp=%v ok=%v", chunked, exp, ok)
	}

	// Malformed: no version.
	if _, _, _, _, ok := parseHead([]byte("GET /x\r\nhost: h\r\n")); ok {
		t.Fatal("malformed head parsed as ok")
	}
	// Malformed: bad content-length.
	if _, _, _, _, ok := parseHead([]byte("GET /x HTTP/1.1\r\ncontent-length: nope\r\n")); ok {
		t.Fatal("bad content-length parsed as ok")
	}
}

func BenchmarkParseHeadGET(b *testing.B) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req, cl, chunked, exp, ok := parseHead(benchHeadGET)
		if !ok || req == nil || cl != -1 || chunked || exp {
			b.Fatal("bad parse")
		}
	}
}

func BenchmarkParseHeadPOST(b *testing.B) {
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		req, cl, chunked, exp, ok := parseHead(benchHeadPOST)
		if !ok || req == nil || cl != 52 || chunked || exp {
			b.Fatal("bad parse")
		}
	}
}
