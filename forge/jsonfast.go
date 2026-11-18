// Fast JSON field extraction for the issue-create hot path.
// Written fresh in Go for v7 Stage 3. Extracts "title", "body" and
// "labels" from a small JSON object without a full decode. Any input
// that does not match the expected shape returns ok=false and the
// caller falls back to encoding/json, so behaviour is identical to
// the generic path (including duplicate keys: last one wins, and
// non-string label elements, which the fallback renders via
// toStringJS).
package main

import (
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

func skipWS(b []byte, i int) int {
	for i < len(b) {
		switch b[i] {
		case ' ', '\t', '\n', '\r':
			i++
		default:
			return i
		}
	}
	return i
}

// scanJSONString parses a JSON string starting at b[i] == '"'.
// Fast path: no escapes, valid UTF-8, return a slice of the input.
// Escapes go through the decoding slow path.
func scanJSONString(b []byte, i int) (string, int, bool) {
	j := i + 1
	for j < len(b) {
		c := b[j]
		if c == '"' {
			if !utf8.Valid(b[i+1 : j]) {
				return "", 0, false
			}
			return string(b[i+1 : j]), j + 1, true
		}
		if c == '\\' {
			return scanJSONStringEscaped(b, i)
		}
		if c < 0x20 {
			return "", 0, false
		}
		j++
	}
	return "", 0, false
}

func hex4(b []byte) (rune, bool) {
	var v rune
	for _, c := range b {
		v <<= 4
		switch {
		case c >= '0' && c <= '9':
			v |= rune(c - '0')
		case c >= 'a' && c <= 'f':
			v |= rune(c-'a') + 10
		case c >= 'A' && c <= 'F':
			v |= rune(c-'A') + 10
		default:
			return 0, false
		}
	}
	return v, true
}

func scanJSONStringEscaped(b []byte, i int) (string, int, bool) {
	var sb strings.Builder
	sb.Grow(32)
	j := i + 1
	for j < len(b) {
		c := b[j]
		if c == '"' {
			s := sb.String()
			if !utf8.ValidString(s) {
				return "", 0, false
			}
			return s, j + 1, true
		}
		if c == '\\' {
			if j+1 >= len(b) {
				return "", 0, false
			}
			switch esc := b[j+1]; esc {
			case '"':
				sb.WriteByte('"')
				j += 2
			case '\\':
				sb.WriteByte('\\')
				j += 2
			case '/':
				sb.WriteByte('/')
				j += 2
			case 'b':
				sb.WriteByte('\b')
				j += 2
			case 'f':
				sb.WriteByte('\f')
				j += 2
			case 'n':
				sb.WriteByte('\n')
				j += 2
			case 'r':
				sb.WriteByte('\r')
				j += 2
			case 't':
				sb.WriteByte('\t')
				j += 2
			case 'u':
				if j+5 >= len(b) {
					return "", 0, false
				}
				r, ok := hex4(b[j+2 : j+6])
				if !ok {
					return "", 0, false
				}
				j += 6
				if utf16.IsSurrogate(r) {
					// Consume the low surrogate only for a valid
					// pair (matching encoding/json: a lone surrogate
					// emits one U+FFFD and leaves the next escape
					// to be processed on its own).
					if j+5 < len(b) && b[j] == '\\' && b[j+1] == 'u' {
						if r2, ok2 := hex4(b[j+2 : j+6]); ok2 {
							if dec := utf16.DecodeRune(r, r2); dec != utf8.RuneError {
								sb.WriteRune(dec)
								j += 6
								continue
							}
						}
					}
					sb.WriteRune(utf8.RuneError)
				} else {
					sb.WriteRune(r)
				}
			default:
				return "", 0, false
			}
			continue
		}
		if c < 0x20 {
			return "", 0, false
		}
		sb.WriteByte(c)
		j++
	}
	return "", 0, false
}

func scanStringArray(b []byte, i int) ([]string, int, bool) {
	// b[i] == '['
	i++
	var out []string
	i = skipWS(b, i)
	if i < len(b) && b[i] == ']' {
		return out, i + 1, true
	}
	for {
		i = skipWS(b, i)
		if i >= len(b) || b[i] != '"' {
			return nil, 0, false
		}
		s, ni, ok := scanJSONString(b, i)
		if !ok {
			return nil, 0, false
		}
		out = append(out, s)
		i = ni
		i = skipWS(b, i)
		if i >= len(b) {
			return nil, 0, false
		}
		if b[i] == ',' {
			i++
			continue
		}
		if b[i] == ']' {
			return out, i + 1, true
		}
		return nil, 0, false
	}
}

// skipValue skips one JSON value starting at i (after whitespace).
func skipValue(b []byte, i int, depth int) (int, bool) {
	if depth > 100 {
		return 0, false
	}
	i = skipWS(b, i)
	if i >= len(b) {
		return 0, false
	}
	switch c := b[i]; {
	case c == '"':
		_, ni, ok := scanJSONString(b, i)
		return ni, ok
	case c == '{':
		i++
		i = skipWS(b, i)
		if i < len(b) && b[i] == '}' {
			return i + 1, true
		}
		for {
			i = skipWS(b, i)
			if i >= len(b) || b[i] != '"' {
				return 0, false
			}
			_, ni, ok := scanJSONString(b, i)
			if !ok {
				return 0, false
			}
			i = ni
			i = skipWS(b, i)
			if i >= len(b) || b[i] != ':' {
				return 0, false
			}
			i++
			ni, ok = skipValue(b, i, depth+1)
			if !ok {
				return 0, false
			}
			i = ni
			i = skipWS(b, i)
			if i >= len(b) {
				return 0, false
			}
			if b[i] == ',' {
				i++
				continue
			}
			if b[i] == '}' {
				return i + 1, true
			}
			return 0, false
		}
	case c == '[':
		i++
		i = skipWS(b, i)
		if i < len(b) && b[i] == ']' {
			return i + 1, true
		}
		for {
			ni, ok := skipValue(b, i, depth+1)
			if !ok {
				return 0, false
			}
			i = ni
			i = skipWS(b, i)
			if i >= len(b) {
				return 0, false
			}
			if b[i] == ',' {
				i++
				continue
			}
			if b[i] == ']' {
				return i + 1, true
			}
			return 0, false
		}
	case c == 't':
		if len(b)-i >= 4 && string(b[i:i+4]) == "true" {
			return i + 4, true
		}
	case c == 'f':
		if len(b)-i >= 5 && string(b[i:i+5]) == "false" {
			return i + 5, true
		}
	case c == 'n':
		if len(b)-i >= 4 && string(b[i:i+4]) == "null" {
			return i + 4, true
		}
	default:
		return skipNumber(b, i)
	}
	return 0, false
}

// skipNumber skips a JSON number; strict enough that anything odd
// falls back to encoding/json.
func skipNumber(b []byte, i int) (int, bool) {
	start := i
	if i < len(b) && b[i] == '-' {
		i++
	}
	if i >= len(b) {
		return 0, false
	}
	if b[i] == '0' {
		i++
	} else if b[i] >= '1' && b[i] <= '9' {
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
		}
	} else {
		return 0, false
	}
	if i < len(b) && b[i] == '.' {
		i++
		if i >= len(b) || b[i] < '0' || b[i] > '9' {
			return 0, false
		}
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
		}
	}
	if i < len(b) && (b[i] == 'e' || b[i] == 'E') {
		i++
		if i < len(b) && (b[i] == '+' || b[i] == '-') {
			i++
		}
		if i >= len(b) || b[i] < '0' || b[i] > '9' {
			return 0, false
		}
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
		}
	}
	if i == start {
		return 0, false
	}
	return i, true
}

// extractIssueFields pulls title/body/labels from a JSON object body.
// ok=false means the caller must fall back to encoding/json.
func extractIssueFields(body []byte) (title, bodyText string, labels []string, ok bool) {
	i := skipWS(body, 0)
	if i >= len(body) || body[i] != '{' {
		return "", "", nil, false
	}
	i++
	i = skipWS(body, i)
	if i < len(body) && body[i] == '}' {
		if skipWS(body, i+1) != len(body) {
			return "", "", nil, false
		}
		return "", "", nil, true
	}
	for {
		i = skipWS(body, i)
		if i >= len(body) || body[i] != '"' {
			return "", "", nil, false
		}
		key, ni, ok2 := scanJSONString(body, i)
		if !ok2 {
			return "", "", nil, false
		}
		i = ni
		i = skipWS(body, i)
		if i >= len(body) || body[i] != ':' {
			return "", "", nil, false
		}
		i++
		i = skipWS(body, i)
		switch key {
		case "title", "body":
			if i >= len(body) || body[i] != '"' {
				return "", "", nil, false
			}
			val, ni, ok2 := scanJSONString(body, i)
			if !ok2 {
				return "", "", nil, false
			}
			if key == "title" {
				title = val
			} else {
				bodyText = val
			}
			i = ni
		case "labels":
			if i >= len(body) || body[i] != '[' {
				return "", "", nil, false
			}
			ls, ni, ok2 := scanStringArray(body, i)
			if !ok2 {
				return "", "", nil, false
			}
			labels = ls
			i = ni
		default:
			ni, ok2 := skipValue(body, i, 0)
			if !ok2 {
				return "", "", nil, false
			}
			i = ni
		}
		i = skipWS(body, i)
		if i >= len(body) {
			return "", "", nil, false
		}
		if body[i] == ',' {
			i++
			continue
		}
		if body[i] == '}' {
			if skipWS(body, i+1) != len(body) {
				return "", "", nil, false
			}
			return title, bodyText, labels, true
		}
		return "", "", nil, false
	}
}

// fastIssueFields extracts title/body/labels for issue creation,
// preferring the hand-rolled scanner and falling back to
// encoding/json for any shape the scanner rejects.
func fastIssueFields(body []byte) (title, bodyText string, labels []string, ok bool) {
	if t, b, l, ok := extractIssueFields(body); ok {
		return t, b, l, true
	}
	parsed, ok := parseJSONBody(body)
	if !ok {
		return "", "", nil, false
	}
	pbody := bodyMap(parsed)
	title, _ = pbody["title"].(string)
	bodyText, _ = pbody["body"].(string)
	if arr, isArr := pbody["labels"].([]any); isArr {
		for _, v := range arr {
			labels = append(labels, toStringJS(v))
		}
	}
	return title, bodyText, labels, true
}
