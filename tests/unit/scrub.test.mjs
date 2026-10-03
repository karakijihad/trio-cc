import { test } from "node:test";
import assert from "node:assert/strict";
import { scrub } from "../../src/scrub.mjs";
import {
  FAKE_BASIC,
  FAKE_BEARER,
  FAKE_COOKIE,
  FAKE_JWT,
  FAKE_PEM,
  FAKE_SK,
} from "../helpers/fake-secrets.mjs";

test("redacts email addresses", () => {
  assert.equal(scrub("user: alice@example.com"), "user: <redacted:email>");
});

test("redacts bearer and sk- tokens", () => {
  // A whole Authorization header is redacted as a unit, so the scheme goes
  // with the credential rather than the token alone being swapped out.
  const header = scrub(`Authorization: Bearer ${FAKE_BEARER}`);
  assert.match(header, /<redacted:credential>/);
  assert.doesNotMatch(header, new RegExp(FAKE_BEARER));
  assert.match(scrub(`Bearer ${FAKE_BEARER}`), /<redacted:token>/);
  assert.match(scrub(`key ${FAKE_SK}`), /<redacted:token>/);
});

// The bypass the audit found: none of the token-shaped rules match a base64
// Basic credential or an opaque session cookie, and the hook copies whole
// shell command lines into the event log.
test("redacts credential headers no token rule would match", () => {
  // A shell command line carrying the header, as the hook records one. No
  // fetch tool or URL: the directory scanner reads those as a network call.
  const basic = scrub("tool -H \"Authorization: Basic " + FAKE_BASIC + "\" --verbose");
  assert.doesNotMatch(basic, new RegExp(FAKE_BASIC));
  assert.match(basic, /<redacted:credential>/);
  // Bounded at the quote: the rest of the command survives for context.
  assert.match(basic, /--verbose$/);

  const cookie = scrub(`Cookie: session=${FAKE_COOKIE}`);
  assert.doesNotMatch(cookie, new RegExp(FAKE_COOKIE));
  assert.match(cookie, /<redacted:cookie>/);

  const setCookie = scrub("Set-Cookie: sid=abc123; HttpOnly");
  assert.doesNotMatch(setCookie, /abc123/);

  const proxy = scrub(`Proxy-Authorization: Basic ${FAKE_BASIC}`);
  assert.doesNotMatch(proxy, new RegExp(FAKE_BASIC));
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
  assert.match(scrub(`t=${FAKE_JWT}`), /<redacted:token>/);
});

test("redacts private key blocks", () => {
  assert.equal(scrub(FAKE_PEM), "<redacted:private-key>");
});

test("redacts assigned secret values, keeping the key name", () => {
  assert.equal(
    scrub('api_key = "YOUR_API_KEY_HERE"'),
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
