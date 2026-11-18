package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func refFields(body []byte) (title, bodyText string, labels []string, ok bool) {
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return "", "", nil, false
	}
	m, isMap := v.(map[string]any)
	if !isMap {
		return "", "", nil, false
	}
	title, _ = m["title"].(string)
	bodyText, _ = m["body"].(string)
	if arr, isArr := m["labels"].([]any); isArr {
		for _, e := range arr {
			labels = append(labels, toStringJS(e))
		}
	}
	return title, bodyText, labels, true
}

func TestExtractIssueFields(t *testing.T) {
	cases := []string{
		`{"title":"t","body":"b"}`,
		`{"title":"t","body":"b","labels":["a","bb"]}`,
		`{ "title" : "spaced" , "body" : "x" , "labels" : [ "l1" , "l2" ] }`,
		`{}`,
		`{"title":""}`,
		`{"title":"esc \"quote\" \\ slash \/ \b\f\n\r\t"}`,
		`{"title":"uni é😀"}`,
		`{"title":"\u0041\u00e9"}`,
		`{"title":"\ud83d\ude00"}`,
		`{"title":"\ud800"}`,
		`{"title":"\ud800\ud800"}`,
		`{"title":"a","title":"b"}`,
		`{"title":"t","extra":123,"nested":{"x":[1,2,{"y":"z"}]},"arr":[true,false,null],"body":"b"}`,
		`{"title":"t","labels":[]}`,
		`{"labels":["x"],"title":"t"}`,
		`{"title":123}`,
		`{"title":"t","labels":[1,true]}`,
		`{"title":"t","labels":"notarray"}`,
		`{"title":"t",}`,
		`{"title":"t"`,
		`not json`,
		``,
		`{"title":"t"} trailing`,
		`{"title":"t","body":"line1\nline2"}`,
		`{"title":"tab\there"}`,
		`{"title":"t","body":"b","labels":["a\"b","c\\d"]}`,
		`{"title":"t","n":1e3,"f":-0.5,"e":1E+10}`,
		`{"title":"t","n":01}`,
		"[1,2]",
		`"just a string"`,
		`{"title":"t","body":"b","labels":["l"],"state":"closed"}`,
	}
	for _, c := range cases {
		rt, rb, rl, rok := refFields([]byte(c))
		// The extractor may legitimately decline (ok=false) for shapes
		// it cannot handle; when it declines, the fallback (refFields)
		// is what the caller uses. When it accepts, values must match.
		// Exception: malformed JSON must be declined (rok=false).
		et, eb, el, eok := extractIssueFields([]byte(c))
		if !rok {
			if eok {
				t.Errorf("input %q: ref rejects but extractor accepts (%q,%q,%v)", c, et, eb, el)
			}
			continue
		}
		if !eok {
			// Declined: fallback would produce the ref result. But the
			// bench shapes must be accepted; flag the common ones.
			if c == `{"title":"t","body":"b"}` || c == `{"title":"t","body":"b","labels":["a","bb"]}` {
				t.Errorf("input %q: extractor declined a bench shape", c)
			}
			continue
		}
		if et != rt || eb != rb || !reflect.DeepEqual(el, rl) {
			// DeepEqual(nil, []) differs; normalize empty.
			if len(el) == 0 && len(rl) == 0 && et == rt && eb == rb {
				continue
			}
			t.Errorf("input %q: got (%q,%q,%v) want (%q,%q,%v)", c, et, eb, el, rt, rb, rl)
		}
	}
	// fastIssueFields must agree with the reference on every case
	// (it falls back internally). Its ok mirrors parseJSONBody: the
	// JSON just has to parse; a non-object yields empty fields.
	for _, c := range cases {
		var v any
		perr := json.Unmarshal([]byte(c), &v)
		// parseJSONBody treats an empty body as ok (null value).
		rok := perr == nil || c == ""
		var rt, rb string
		var rl []string
		if m, isMap := v.(map[string]any); isMap {
			rt, _ = m["title"].(string)
			rb, _ = m["body"].(string)
			if arr, isArr := m["labels"].([]any); isArr {
				for _, e := range arr {
					rl = append(rl, toStringJS(e))
				}
			}
		}
		ft, fb, fl, fok := fastIssueFields([]byte(c))
		if rok != fok {
			t.Errorf("fast input %q: ok got %v want %v", c, fok, rok)
			continue
		}
		if rok && (ft != rt || fb != rb || !reflect.DeepEqual(fl, rl)) {
			if len(fl) == 0 && len(rl) == 0 && ft == rt && fb == rb {
				continue
			}
			t.Errorf("fast input %q: got (%q,%q,%v) want (%q,%q,%v)", c, ft, fb, fl, rt, rb, rl)
		}
	}
}
