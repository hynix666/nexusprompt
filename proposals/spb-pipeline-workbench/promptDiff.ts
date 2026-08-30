/**
 * Word-aware text diffing for prompt revision comparison.
 *
 * Two exports, both pure and synchronous:
 *   unifiedPromptDiff(prior, current)      -> unified row list, changed rows carry word tokens
 *   highlightedPromptLines(subject, other) -> per-line word tokens for `subject`, marked against `other`
 *
 * Design notes
 * ------------
 * Line alignment uses Myers-style LCS over line hashes. Full LCS is O(n*m) in
 * time and memory, which is fine for prompts but not for pathological inputs,
 * so the implementation trims the common prefix and suffix first and falls back
 * to a positional (non-optimal but linear) alignment when the remaining problem
 * exceeds MAX_LCS_CELLS. That keeps the worst case bounded without penalising
 * the normal case, where prompts differ by a handful of lines.
 */

export interface DiffToken {
  /** Token text with original spacing collapsed to single separators. */
  text: string;
  /** True when this token is not present in the aligned counterpart line. */
  changed: boolean;
}

export type DiffRowType = "added" | "removed" | "context";

export interface DiffRow {
  type: DiffRowType;
  /** Whole-line text. Always populated. */
  text: string;
  /** Word-level breakdown. Present only on rows paired with a counterpart. */
  tokens?: DiffToken[];
}

/** Above this many DP cells, fall back to positional alignment. ~16M bytes of Int32. */
const MAX_LCS_CELLS = 4_000_000;

/** Longest input either side will be diffed at full fidelity. */
const MAX_INPUT_CHARS = 400_000;

const splitLines = (value: string): string[] => (value || "").replace(/\r\n?/g, "\n").split("\n");

/** Split into words while keeping punctuation attached, so `foo,` and `foo` differ. */
const splitWords = (line: string): string[] => (line.match(/\S+/g) ?? []);

/**
 * Longest common subsequence over two arrays of line strings.
 * Returns index pairs `[i, j]` of matched lines, ascending.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    // Degenerate fallback: pair up identical lines at identical offsets only.
    const pairs: Array<[number, number]> = [];
    const shared = Math.min(n, m);
    for (let i = 0; i < shared; i++) if (a[i] === b[i]) pairs.push([i, i]);
    return pairs;
  }

  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Mark tokens of `subject` that do not appear, in LCS order, in `other`.
 * Symmetric by construction: call twice with the arguments swapped to highlight
 * both sides of a pair.
 */
function markWords(subject: string, other: string): DiffToken[] {
  const subjectWords = splitWords(subject);
  const otherWords = splitWords(other);
  if (subjectWords.length === 0) return [];
  if (otherWords.length === 0) return subjectWords.map((text) => ({ text, changed: true }));

  const kept = new Set(lcsPairs(subjectWords, otherWords).map(([index]) => index));
  return subjectWords.map((text, index) => ({ text, changed: !kept.has(index) }));
}

/** Truncate defensively so a pathological paste cannot wedge the UI thread. */
function clamp(value: string): string {
  const text = value || "";
  return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n…[truncated for diff]` : text;
}

/**
 * Unified diff between two prompt revisions.
 * Rows are emitted in `current` order; removed rows are interleaved at the
 * position they occupied in `prior`. Paired add/remove runs carry word tokens.
 */
export function unifiedPromptDiff(prior: string, current: string): DiffRow[] {
  const before = splitLines(clamp(prior));
  const after = splitLines(clamp(current));
  const pairs = lcsPairs(before, after);

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;

  const flushBlock = (removed: string[], added: string[]): void => {
    // Pair removals with additions positionally so word highlighting has a counterpart.
    const shared = Math.min(removed.length, added.length);
    for (let k = 0; k < shared; k++) {
      rows.push({ type: "removed", text: removed[k], tokens: markWords(removed[k], added[k]) });
      rows.push({ type: "added", text: added[k], tokens: markWords(added[k], removed[k]) });
    }
    for (let k = shared; k < removed.length; k++) {
      rows.push({ type: "removed", text: removed[k], tokens: markWords(removed[k], "") });
    }
    for (let k = shared; k < added.length; k++) {
      rows.push({ type: "added", text: added[k], tokens: markWords(added[k], "") });
    }
  };

  for (const [ai, bj] of pairs) {
    const removed: string[] = [];
    const added: string[] = [];
    while (i < ai) removed.push(before[i++]);
    while (j < bj) added.push(after[j++]);
    if (removed.length || added.length) flushBlock(removed, added);
    rows.push({ type: "context", text: after[bj] });
    i++;
    j++;
  }

  const tailRemoved: string[] = [];
  const tailAdded: string[] = [];
  while (i < before.length) tailRemoved.push(before[i++]);
  while (j < after.length) tailAdded.push(after[j++]);
  if (tailRemoved.length || tailAdded.length) flushBlock(tailRemoved, tailAdded);

  return rows;
}

/**
 * Per-line word tokens for `subject`, with `changed` set on words that are not
 * matched in the line `other` aligns to. Used to render side-by-side panes:
 * call with (prior, current) for the left pane and (current, prior) for the right.
 */
export function highlightedPromptLines(subject: string, other: string): DiffToken[][] {
  const subjectLines = splitLines(clamp(subject));
  const otherLines = splitLines(clamp(other));
  const pairs = lcsPairs(subjectLines, otherLines);

  // Map every subject line to its counterpart: exact matches from the LCS,
  // unmatched lines to the nearest unmatched counterpart in the same gap.
  const counterpart = new Map<number, number>();
  for (const [si, oi] of pairs) counterpart.set(si, oi);

  let previousSubject = -1;
  let previousOther = -1;
  const gapFill = (endSubject: number, endOther: number): void => {
    const unmatchedSubject: number[] = [];
    const unmatchedOther: number[] = [];
    for (let s = previousSubject + 1; s < endSubject; s++) unmatchedSubject.push(s);
    for (let o = previousOther + 1; o < endOther; o++) unmatchedOther.push(o);
    const shared = Math.min(unmatchedSubject.length, unmatchedOther.length);
    for (let k = 0; k < shared; k++) counterpart.set(unmatchedSubject[k], unmatchedOther[k]);
  };

  for (const [si, oi] of pairs) {
    gapFill(si, oi);
    previousSubject = si;
    previousOther = oi;
  }
  gapFill(subjectLines.length, otherLines.length);

  return subjectLines.map((line, index) => {
    const otherIndex = counterpart.get(index);
    const against = otherIndex === undefined ? "" : otherLines[otherIndex] ?? "";
    if (against === line) return splitWords(line).map((text) => ({ text, changed: false }));
    return markWords(line, against);
  });
}
