/**
 * Types for `check-schema-self-reference.mjs`.
 *
 * The checker is `.mjs` like every other one here, so TypeScript infers `renderLedger`'s
 * accumulator as bare `{}` and a test cannot pass the result anywhere expecting a record.
 * `check-merge-integrity.d.mts` exists for the same reason.
 */

export interface ProseSite {
  /** Dotted path to the field, e.g. `properties.revisions.items.$comment`. */
  path: string;
  text: string;
  versions: string[];
}

export interface SchemaSelfReference {
  name: string;
  /** The version in the schema's `$id`. */
  version: string;
  prose: ProseSite[];
  fingerprint: string;
  /** Every semver mentioned in prose, sorted. Readable in a diff; the fingerprint decides. */
  mentions: string[];
}

export interface LedgerEntry {
  acknowledged_at: string;
  fingerprint: string;
  mentions: string[];
  reviewed: string;
}

export interface SelfReferenceProblem {
  schema: string;
  why: string;
  sentences: ProseSite[];
}

export interface SelfReferenceResult {
  ok: boolean;
  fatal: string | null;
  problems: SelfReferenceProblem[];
  schemas: SchemaSelfReference[];
}

export function versionBearingProse(schema: unknown): ProseSite[];
export function fingerprint(prose: ProseSite[]): string;
export function readSchemas(root?: string): SchemaSelfReference[];
export function renderLedger(schemas: SchemaSelfReference[], reviewed: string): Record<string, LedgerEntry>;
export function checkSchemaSelfReference(root?: string): SelfReferenceResult;
