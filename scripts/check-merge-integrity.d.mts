export interface MergeIntegrityOptions {
  root?: string;
  fetchImpl?: typeof fetch;
  git?: (args: string[]) => { status: number; stdout: string };
  token?: string | null;
}

export interface MergeIntegrityFinding {
  pr: number;
  title: string;
  base: string | undefined;
  merge_commit: string;
  absent_commits: string[];
}

export interface MergeIntegrityExplained {
  pr: number;
  title: string;
  base: string | undefined;
  merge_commit: string;
  reason: string;
}

export interface MergeIntegrityStaleLedger {
  pr: number;
  title: string;
  merge_commit: string;
  ledger_entry: unknown;
}

export interface MergeIntegrityUnclassified {
  pr: number;
  title: string | undefined;
  reason: string;
}

export type MergeIntegrityResult =
  | {
      ok: false;
      fatalCode: 2;
      fatal: string;
      checked: 0;
      silent: 0;
      findings: [];
      explained: [];
      stale_ledger: [];
      unclassified: [];
    }
  | {
      ok: true;
      fatalCode: null;
      fatal: null;
      checked: number;
      silent: number;
      findings: MergeIntegrityFinding[];
      explained: MergeIntegrityExplained[];
      stale_ledger: MergeIntegrityStaleLedger[];
      unclassified: MergeIntegrityUnclassified[];
    };

export function checkMergeIntegrity(opts?: MergeIntegrityOptions): Promise<MergeIntegrityResult>;
