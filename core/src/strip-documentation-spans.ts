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
//
// ## There are TWO fence readers in this codebase, and they do not agree
//
// This one, and `extractRuntimeManifest` in `gates/lint-primitives.ts`. Stated here because
// the file's own history is full of the cost of two readers of one concept drifting apart —
// the two declaration readers that accepted disjoint syntaxes, the manifest span that meant
// something different from the ledger span.
//
//                        this (USE side)              extractRuntimeManifest (HEADING side)
//   tilde fences         not recognised at all        recognised
//   indent               any amount (left-trimmed)    at most three spaces
//   closer + info string treated as a closer          NOT a closer (CommonMark)
//
// The divergence is deliberate and is NOT a defect, for one reason: it errs the same way in
// both directions. This reader closing MORE eagerly strips LESS, so more text is audited and
// the six gates that call it fire more often. The manifest reader closing LESS eagerly hides
// MORE, so fewer keys are declared and RUNTIME_KEY_UNDECLARED fires more often. Both are the
// visible-FAIL direction. A false clean would need the opposite pairing — a declaration this
// reader considers visible while the use is hidden — and the heading indent cap is what rules
// that out: a four-space-indented fence opens here but the heading inside it is an indented
// code block over there, so it declares nothing.
//
// Do not "unify" them without an ADR. This function is a port of frozen source (lines
// 250-276) consumed by six gates, so changing its fence rule changes six gates' verdicts and
// every one of those is a differential divergence to declare. The manifest reader is already
// carved out by ADR-0010; this one is not.

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
