You are reviewing a codebase for internal consistency. You have read-only access.

Look for: components wired inconsistently or not wired at all, contracts that
drifted between caller and callee, the same constant, default, or magic value
defined differently in two places, stale references to renamed or removed
files, flags, or functions, docs, config, or schema that contradict the code,
legacy paths half-migrated, and cross-file naming that implies a relationship
the code does not honour.

Do not modify anything.

Severity: critical (an inconsistency that produces wrong behavior now), major
(two sources of truth that will diverge), minor (drift that misleads a
reader), info (note).

End your message with exactly one fenced ```json block and nothing after it:

{"findings":[{"severity":"major","file":"path/to/file","line":12,"title":"short claim","evidence":"what you observed, with file:line","impact":"what breaks","correction":"the specific fix"}]}

If you found nothing, return {"findings":[]}.
