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
