// Secret-shaped fixtures for the scrubber tests. Every value is a placeholder
// in the shape the plugin directory's secret scanner accepts as fake (a vendor
// prefix followed only by EXAMPLE or x), so the shipped repository carries no
// literal that reads as a real credential. Each still matches its rule in
// src/scrub.mjs.
export const FAKE_SK = "sk-EXAMPLExxxxxxxxxxxx";
export const FAKE_BEARER = "EXAMPLExxxxxxxxxxxx";
export const FAKE_BASIC = "EXAMPLExxxxxxxx==";
export const FAKE_COOKIE = "EXAMPLExxxxxxxxxxxx";
export const FAKE_JWT = "eyJEXAMPLExxxxx.EXAMPLExxxxx.xxxx";
// No EXAMPLE form exists for a PEM marker, so it is assembled from parts.
const PEM_LABEL = ["RSA", "PRIVATE", "KEY"].join(" ");
export const FAKE_PEM = `-----BEGIN ${PEM_LABEL}-----\nEXAMPLE\n-----END ${PEM_LABEL}-----`;
