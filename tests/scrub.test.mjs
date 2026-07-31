import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../src/scrub.mjs";

test("redacts email addresses", () => {
  assert.equal(scrub("user: alice@example.com"), "user: <redacted:email>");
});

test("redacts bearer and sk- tokens", () => {
  assert.match(
    scrub("Authorization: Bearer abcdef1234567890abcdef"),
    /<redacted:token>/,
  );
  assert.match(scrub("key sk-proj-AAAABBBBCCCCDDDD1234"), /<redacted:token>/);
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
