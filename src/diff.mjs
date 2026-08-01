// lcsTable allocates an (a+1)x(b+1) matrix, so cost is the product of the two
// side lengths — and this runs synchronously inside the PostToolUse hook on
// every Edit and Write. A single generated file can be tens of thousands of
// lines, which is billions of cells and a hook that never returns. The tap's
// byte ceiling cannot help: it measures the log already on disk, not the edit
// arriving now.
//
// Past the cap the diff is summarised rather than computed. A summary is a
// worse record than a diff; a hung tool call is worse than both.
export const MAX_DIFF_LINES = 4000;

function lcsTable(a, b) {
  const t = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      t[i][j] =
        a[i] === b[j]
          ? t[i + 1][j + 1] + 1
          : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  return t;
}

export function unifiedDiff(filePath, oldStr, newStr) {
  const a = String(oldStr ?? "").split("\n");
  const b = String(newStr ?? "").split("\n");
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();

  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    lines.push(
      `@@ diff not computed — ${a.length} line(s) before, ${b.length} after, over the ${MAX_DIFF_LINES}-line cap @@`,
    );
    return lines.join("\n");
  }

  const t = lcsTable(a, b);
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if (t[i + 1][j] >= t[i][j + 1]) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < a.length) lines.push(`-${a[i++]}`);
  while (j < b.length) lines.push(`+${b[j++]}`);
  return lines.join("\n");
}
