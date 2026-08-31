/**
 * The `tone_check` stage — pure. Frozen s11, "Tone Check", role `tone`.
 *
 * The eleventh stage, and one of the two the inherited `docs/` tree never mentions. It runs
 * only at STANDARD depth and above — `DEPTH_PLAN` omits it from TINY and MINIMAL.
 *
 * **Advisory, not a gate.** Its own system prompt ends "never claim a finding here blocks
 * compilation", and `VOICE_LEVELS` has no failing value: the worst outcome is INCONSISTENT,
 * which is a report, not a verdict. That distinction is load-bearing — a voice audit that
 * could block a compile would make a stylistic opinion a release gate.
 *
 * Template and system prompt both ported verbatim; `check:stages` compares the template
 * against the frozen source.
 */

import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";
import { fillTemplate, buildRequest, failurePlaceholder, MAX_TOKENS, refuseForgedMarker } from "./stage-kit.js";

export const STAGE_ID = "tone_check" as const;

const TEMPLATE = `VOICE & TONE AUDIT.

CALIBRATION (declared profile this prompt should match):
{calibration}

COMPILED PROMPT TO AUDIT:
{prompt}

Check the compiled prompt for register drift, person/address drift, calibration mismatch, and terminology drift as defined in your instructions. Quote the drifting phrase and name its section for every finding.`;

/** Ported verbatim. Like the critic, this stage gets its own identity, not the compiler's. */
export const TONE_SYSTEM = `You are the Voice & Tone Auditor in a prompt-compilation pipeline (unified compiler v1.0). You do not check placeholders, gates, or guardrail coverage — Lint and Critic already own that. You check ONE thing: whether the compiled system prompt reads as ONE consistent voice throughout, and whether that voice matches its declared temperature/calibration profile.
Check for:
(a) REGISTER DRIFT — sections that swing between formal/clinical and casual/chatty without reason.
(b) PERSON & ADDRESS DRIFT — inconsistent use of first/second/third person, or inconsistent naming of the agent or the user across sections.
(c) CALIBRATION MISMATCH — a HIGH-TEMPERATURE (creative/open-ended) profile written in rigid checklist prose, or a LOW-TEMPERATURE (deterministic/technical) profile written in loose, hedging, or flowery prose.
(d) TERMINOLOGY DRIFT — the same concept named differently in different sections (e.g. "user" vs "player" vs "customer" for the same entity).
Output EXACTLY this format — first line one of:
VOICE: CONSISTENT
VOICE: MINOR_DRIFT
VOICE: INCONSISTENT
then up to 5 numbered findings, one line each, quoting the drifting phrase and the section it's in. CONSISTENT may have zero findings. This is advisory, not a gate — never claim a finding here blocks compilation.`;

/** Three levels, none of them failing. The worst is a report, not a verdict. */
export type VoiceLevel = "CONSISTENT" | "MINOR_DRIFT" | "INCONSISTENT";

/** Depths at which s11 runs at all, per the frozen DEPTH_PLAN. */
export const TONE_DEPTHS = ["STANDARD", "COMPREHENSIVE"] as const;

export interface ToneCheckInput {
  prompt: string;
  /** The profile from `calibrate`. Absent substitutes the shared default. */
  calibration?: string;
  depth?: string;
}

export interface ToneCheckState {
  voice: VoiceLevel;
  report: string;
  demo_mode: boolean;
}

/** Below STANDARD depth the stage does not run. Core decides; the Application acts. */
export const shouldSkip = (input: ToneCheckInput): boolean =>
  !TONE_DEPTHS.includes((input.depth ?? "") as (typeof TONE_DEPTHS)[number]);

/**
 * Parse the voice line, defaulting to MINOR_DRIFT.
 *
 * Not CONSISTENT: an unparseable reply is an audit that did not happen, and reading it as
 * clean would be the same mistake the critic's DEGRADED default avoids. Not INCONSISTENT
 * either — this stage is advisory, and inventing a worst-case finding from a parse failure
 * would put noise into a report people are meant to act on.
 */
export function parseVoice(text: string): VoiceLevel {
  const m = text.match(/VOICE:\s*(CONSISTENT|MINOR_DRIFT|INCONSISTENT)/i);
  return m ? (m[1].toUpperCase() as VoiceLevel) : "MINOR_DRIFT";
}

export function decide(input: ToneCheckInput, run_id: string): GenerationRequest {
  return buildRequest(
    run_id, STAGE_ID,
    fillTemplate(TEMPLATE, { prompt: input.prompt, calibration: input.calibration }),
    { system: TONE_SYSTEM, max_tokens: MAX_TOKENS.tone, effort: "low" },
  );
}

export function reduce(
  input: ToneCheckInput,
  outcome: GenerationResult | ProviderFailure,
): ToneCheckState {
  // A forged marker is a provider failure, decided before the branch so every stage
  // inherits it through the placeholder path it already has.
  const settled = refuseForgedMarker(outcome);
  const isFailure = "category" in settled;
  if (isFailure) {
    return {
      voice: "MINOR_DRIFT",
      report: failurePlaceholder(STAGE_ID, input.prompt, settled as ProviderFailure),
      demo_mode: true,
    };
  }
  const report = (settled as GenerationResult).content;
  return { voice: parseVoice(report), report, demo_mode: false };
}

/** The skip path, for depths below STANDARD. Nothing ran, so nothing is claimed. */
export function reduceSkipped(): ToneCheckState {
  return {
    voice: "MINOR_DRIFT",
    report: "[SKIPPED] Tone Check runs at STANDARD depth and above. [ASSUMPTION:voice_unaudited]",
    demo_mode: false,
  };
}
