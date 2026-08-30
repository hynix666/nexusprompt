/**
 * The redaction check the observability claim has always described and never had.
 *
 * `PRIVACY_AND_SECURITY.md` claim 1 says "No prompt bodies in logs, ever", and
 * `OBSERVABILITY.md` says it is "enforced in `observability/sink.ts` itself (a redaction check
 * runs before any event is written), not left as a convention for call sites to honor. The sink
 * rejects, rather than truncates, any payload containing a body."
 *
 * `observability/` does not exist. No sink module is tracked. Every sink in the repository is an
 * inline lambda, so the property was exactly the per-call-site convention the document says it
 * is not — and sweep fourteen found the convention broken on the error path: `failStage` copied
 * `err.message` into `DEGRADE.verdict`, and an error message carries whatever text produced it.
 * A provider adapter throwing a parse error that quotes its payload put the prompt body into
 * four events.
 *
 * ## What this can and cannot decide
 *
 * "Does this string contain a prompt body?" is not decidable in general, and a check claiming
 * to answer it would be the same overreach as the sentence it replaces. What IS decidable is
 * the question that matters here: does this event share a long verbatim run with a body THIS
 * RUN is holding? The Application knows the brief, the prompt and the stage output, so it can
 * compare against them exactly.
 *
 * That bounds the guarantee honestly:
 *   - it catches a body copied, sliced or embedded into any string field;
 *   - it does NOT catch a paraphrase, a translation, or a body from some other run;
 *   - it does NOT catch a short body — under `WINDOW` characters there is no window to match,
 *     and lowering the threshold turns ordinary English into a false positive.
 *
 * Rejecting rather than truncating is the documented behaviour and the right one: a truncated
 * body is still a body, and silently shortening it would leave the caller believing it emitted
 * something safe.
 */

import type { EventSink, ObservabilityEvent } from "../../contracts/index.js";

/**
 * The verbatim run length that counts as a leak.
 *
 * 32 characters is long enough that ordinary shared English ("the following requirements")
 * does not collide, and short enough that a sliced body still trips it — `failStage` truncated
 * to 200 characters and would have passed a 256-character threshold while leaking 200
 * characters of prompt.
 */
export const WINDOW = 32;

/** Every WINDOW-length window of `text`, normalised so whitespace reflow cannot evade it. */
const windows = (text: string): Set<string> => {
  const flat = text.replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i + WINDOW <= flat.length; i++) out.add(flat.slice(i, i + WINDOW));
  return out;
};

/**
 * Does `field` share a verbatim window with any body?
 *
 * Compares the field's windows against the bodies' window set, so a body embedded anywhere in
 * a longer string is found — which is the shape the leak actually took, a body inside a
 * sentence about a provider failure.
 */
export const sharesBody = (field: string, bodies: readonly string[]): boolean => {
  const flat = field.replace(/\s+/g, " ").trim();
  if (flat.length < WINDOW) return false;
  const haystack = new Set<string>();
  for (const b of bodies) for (const w of windows(b)) haystack.add(w);
  if (haystack.size === 0) return false;
  for (let i = 0; i + WINDOW <= flat.length; i++) {
    if (haystack.has(flat.slice(i, i + WINDOW))) return true;
  }
  return false;
};

/** What replaces a field that carried a body. Contains none of it. */
export const REDACTED = "[redacted: field shared a verbatim run with a prompt body]";

/**
 * Wrap a sink so no event carrying a body can reach it.
 *
 * `bodies` is a callback rather than a value because the run's prompt changes as stages rewrite
 * it — a snapshot taken at wrap time would stop covering the artifact halfway through the run,
 * which is precisely when there is most to leak.
 *
 * ## Substitute the field; do not throw
 *
 * The first version threw, which is the literal reading of "the sink rejects". It also killed
 * the run: `failStage` emits from inside a catch, so a provider error whose message quoted the
 * brief turned a gracefully degrading run into an aborted one — the artifact lost to a LOGGING
 * concern. A privacy control should fail closed on the body, not on availability.
 *
 * So the body never reaches the sink and the event still does, with the offending field
 * replaced by a marker that contains none of it. That is not truncation — a truncated body is
 * still a body, which is the thing the original wording was right to forbid. The event stream
 * stays complete, and a redaction is visible in it rather than inferred from a gap.
 */
export function redactingSink(inner: EventSink, bodies: () => readonly string[]): EventSink {
  return {
    emit(event: ObservabilityEvent) {
      const live = bodies().filter((b) => typeof b === "string" && b.length >= WINDOW);
      if (live.length === 0) return inner.emit(event);

      let safe: Record<string, unknown> | null = null;
      for (const [field, value] of Object.entries(event)) {
        if (typeof value === "string" && sharesBody(value, live)) {
          safe ??= { ...event };
          safe[field] = REDACTED;
        }
      }
      inner.emit((safe ?? event) as ObservabilityEvent);
    },
  };
}
