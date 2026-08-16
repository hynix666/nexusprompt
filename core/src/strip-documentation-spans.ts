// Ported from sources/v5/prompt_lint.py:250-276 (manifest: v5/prompt_lint)
// See sources/MANIFEST.json for the frozen source hash.
//
// Removes fenced code blocks and inline backtick spans before auditing. Documents
// that *describe* a syntax — a key shown as an example, a template schema inside a
// fence — must not trip gates that scan for the real thing. Lint targets the live
// prompt body; illustrative spans are exempt.
//
// The source uses a line-based state machine rather than a dot-all regex, so a fence
// opened and never closed strips to EOF. That is deliberate and safe-side: an unclosed
// template block stays exempt rather than becoming auditable. The port preserves it.

/** Count leading backticks after left-trimming whitespace. */
function leadingTicks(line: string): number {
  const stripped = line.replace(/^\s+/, "");
  const m = stripped.match(/^`+/);
  return m ? m[0].length : 0;
}

export function stripDocumentationSpans(text: string): string {
  const out: string[] = [];
  let fenceLen = 0; // 0 = not in a fence; else backtick count of the OPEN fence

  for (const line of text.split("\n")) {
    const stripped = line.replace(/^\s+/, "");
    if (stripped.startsWith("```")) {
      const ticks = leadingTicks(line);
      if (fenceLen === 0) {
        fenceLen = ticks; // opening fence
        continue;
      }
      if (ticks >= fenceLen) {
        // CommonMark: a closing fence must be at least as long as the opening one.
        fenceLen = 0;
        continue;
      }
      // A shorter fence inside a longer one is CONTENT (``` inside ````) — fall
      // through so the line is dropped as fenced content rather than treated as a close.
    }
    if (fenceLen === 0) out.push(line);
  }

  // Inline spans last, and deliberately non-greedy within a line: `[^`\n]*`
  return out.join("\n").replace(/`[^`\n]*`/g, "");
}
