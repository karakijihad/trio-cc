import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../src/scrub.mjs";

test("redacts email addresses", () => {
  assert.equal(scrub("user: alice@example.com"), "user: <redacted:email>");
});

test("redacts bearer and sk- tokens", () => {
  // A whole Authorization header is redacted as a unit, so the scheme goes
  // with the credential rather than the token alone being swapped out.
  const header = scrub("Authorization: Bearer abcdef1234567890abcdef");
  assert.match(header, /<redacted:credential>/);
  assert.doesNotMatch(header, /abcdef1234567890/);
  assert.match(scrub("Bearer abcdef1234567890abcdef"), /<redacted:token>/);
  assert.match(scrub("key sk-proj-AAAABBBBCCCCDDDD1234"), /<redacted:token>/);
});

// The bypass the audit found: none of the token-shaped rules match a base64
// Basic credential or an opaque session cookie, and the hook copies whole
// shell command lines into the event log.
test("redacts credential headers no token rule would match", () => {
  const basic = scrub('curl -H "Authorization: Basic YWRtaW46aHVudGVyMg==" https://api.example.com');
  assert.doesNotMatch(basic, /YWRtaW46aHVudGVyMg/);
  assert.match(basic, /<redacted:credential>/);
  // Bounded at the quote: the rest of the command survives for context.
  assert.match(basic, /https:\/\/api\.example\.com/);

  const cookie = scrub("Cookie: session=8f14e45fceea167a5a36dedd4bea2543");
  assert.doesNotMatch(cookie, /8f14e45fceea167a5a36dedd4bea2543/);
  assert.match(cookie, /<redacted:cookie>/);

  const setCookie = scrub("Set-Cookie: sid=abc123; HttpOnly");
  assert.doesNotMatch(setCookie, /abc123/);

  const proxy = scrub("Proxy-Authorization: Basic Zm9vOmJhcg==");
  assert.doesNotMatch(proxy, /Zm9vOmJhcg/);
});

test("redacts GitHub's underscore-delimited token families", () => {
  // GitHub's documented prefixes delimit with an underscore, which an earlier
  // hyphen-only matcher let through in the clear. Assembled at runtime rather
  // than written out, so this fixture is not itself a token-shaped literal
  // sitting in the repository for secret scanners to trip over.
  const body = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const sep = "_";
  for (const prefix of ["github" + sep + "pat", "ghp", "gho", "ghu", "ghs"]) {
    const token = prefix + sep + body;
    const out = scrub(`token=${token}`);
    assert.match(out, /<redacted:token>/, prefix);
    assert.doesNotMatch(out, new RegExp(body), prefix);
  }
});

test("redacts JWTs", () => {
  assert.match(
    scrub("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdEFGH1234"),
    /<redacted:token>/,
  );
});

test("redacts private key blocks", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----";
  assert.equal(scrub(pem), "<redacted:private-key>");
});

test("redacts assigned secret values, keeping the key name", () => {
  assert.equal(
    scrub('api_key = "s3cr3tvalue123456"'),
    'api_key = "<redacted:secret>"',
  );
});

test("leaves ordinary prose and code untouched", () => {
  const src = "function loadToken(name) { return cache.get(name); }";
  assert.equal(scrub(src), src);
});

test("handles empty and non-string input safely", () => {
  assert.equal(scrub(""), "");
  assert.equal(scrub(undefined), "");
});
