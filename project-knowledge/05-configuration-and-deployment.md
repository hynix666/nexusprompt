# Configuration and deployment

## Runtime requirements

| | |
|---|---|
| Node | 24+ |
| Package manager | **npm** (workspaces). pnpm is *not* installed; older docs saying `pnpm` are wrong |
| Python | 3.12+ — required by the differential oracle only |
| OS | developed on Windows 11 (Git Bash + PowerShell); CI runs ubuntu-latest |

```bash
npm install && npm run verify     # ~16 s, offline
```

## Environment variables

| Variable | Read by | Required | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `adapters/provider-local-proxy` | only for `--live` | `<REDACTED>` — never stored, logged, or printed by this repo. Presence is all any script checks |
| `ANTHROPIC_BASE_URL` | **nothing** | — | deliberately ignored; the adapter hard-codes `api.anthropic.com` against a frozen allowlist |

There is **no `.env` file** in this repository and none is read. Set the key in your shell:

```bash
export ANTHROPIC_API_KEY='<your key>'          # bash / zsh
$env:ANTHROPIC_API_KEY = '<your key>'          # PowerShell, session only
```

`npm run eval -- --live` refuses up front when it is unset, rather than degrading every case
and reporting a score.

## Workspace layout — root `package.json`

```json
{
  "name": "nexusprompt",
  "license": "MIT",
  "private": true,
  "type": "module",
  "workspaces": ["contracts", "core", "application", "adapters/*", "shells/*"]
}
```

Every workspace package is `@nexusprompt/<name>`. **Nothing imports by package name** — all
cross-layer imports are relative paths — so the workspace symlinks are organisational, not
load-bearing.

## TypeScript — `tsconfig.json`

```jsonc
{
  "target": "ES2022",
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "strict": true,
  "noUnusedLocals": true,       // found 7 dead imports the day it went on
  "noUnusedParameters": true,
  "noImplicitOverride": true
}
```

Two stricter flags were **measured and not adopted**, with the counts recorded in the config
so the decision is a number rather than an intention:

| Flag | Errors | Status |
|---|---|---|
| `exactOptionalPropertyTypes` | 25 | deferred |
| `noUncheckedIndexedAccess` | 208 | deferred |

## `verify` — the whole check

```
check:hygiene → lint:boundaries → typecheck → verify:sources → check:counts → check:plan
→ check:citations → check:catalog → check:xsd → check:depth → check:stages
→ check:sizing → check:anchor → check:matrix → check:manifest-spec
→ check:truth → check:fingerprint
→ eval → eval:compare → eval:adversarial → eval:pipeline → eval:anchor
→ test → differential
```

**The order is meaningful**: boundaries and schema validation first, then Core, then
Application, adapters, cross-shell parity, adversarial corpus, reproducibility last.

### One check is deliberately *outside* `verify`

`check:corpus` re-hashes 661 PDFs under `PDF/` — 2 GB, gitignored, canonical home arXiv. A
fresh checkout has never had it, so folding it into `verify` would make the headline command
fail for every adopter. **`verify` checks the repository; `check:corpus` checks a local
asset.**

If it ever reports missing files, **do not** regenerate the manifest with `--write` — that
silently accepts the disappearance of the evidence base. Find the corpus.

## CI — `.github/workflows/verify.yml`

```yaml
on: { push: { branches: [master, main] }, pull_request: , workflow_dispatch: }
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7    # node 24, npm cache
      - uses: actions/setup-python@v7  # 3.12 — the oracle shells out to Python
      - run: npm ci
      - run: npm run verify
```

Python is set up because **an oracle that silently skips is worse than none** (ADR-0007).

First executed 23 August 2026, green on the first run: `npm ci` plus the full `verify` on a
clean Ubuntu checkout. That is what makes the guards real rather than local habit.

## Deployment

There is nothing to deploy. No server, no container, no database, no hosted artifact. The CLI
runs locally; CI runs the same `verify` a developer runs.

Runtime state lives under the working directory:

| Path | Contents | Lifetime |
|---|---|---|
| `.nexusprompt/runs/` | run bundles | 8 kept, evicted whole |
| `.nexusprompt/evidence/` | eval-run, comparison, baseline, promotion | append-only, never evicted |

Different lifetimes on purpose — pointing them at one directory would put a retention policy
in front of the records a promotion cites.

## Large assets not in git

| Path | Size | What it is |
|---|---|---|
| `PDF/` | 2.0 GB, 661 files | research corpus; 599 unique documents (62 byte-identical duplicates). Pinned by `scripts/corpus-manifest.json` |
| `LLM/` | 811 MB | int4 ONNX model + tokenizer. **Not wired and not wire-able as dropped** — see below |
| `*.zip`, extracted archive dirs | — | five source archives; `sources/` holds the frozen extraction |

### The local model — investigated and deliberately left unwired

`LLM/` is an ONNX Runtime GenAI export: 16 blocks (10 short-conv + 6 attention),
`GroupQueryAttention` / `MatMulNBits` / `GatherBlockQuantized`, all `com.microsoft` contrib
ops that *do* have CPU kernels.

**`genai_config.json` is absent**, as is any `config.json`. Head counts, head size, hidden
size, context length and rope theta appear nowhere in the drop or anywhere on disk.
Reconstructing them means guessing, and **a wrong parameter produces fluent garbage rather
than an error** — which would defeat the demo-mode guarantee outright, since no gate can
distinguish plausible text from a real answer.

*Closes when:* the config lands with the model, or the parameters are recovered from the graph
tensor shapes and a known-answer test pins one deterministic completion first.

## Frozen inputs

`sources/` holds **420 files**, SHA-256-pinned against `sources/MANIFEST.json` and verified by
`verify:sources` on every run.

- **Read from these; never write into them** (I6). Corrections happen at the import boundary.
- 52 of them contain the string `promptnexus` — a global rename would break the freeze.

## Naming (ADR-0009)

The product is **NexusPrompt**. Two things deliberately keep the older name:

| Keeps `promptnexus` | Why |
|---|---|
| Contract `$id` hosts | renaming is 15 major version bumps for a rebrand — the change ADR-0002 exists to make expensive. `$id` is an identifier, not an address; nothing resolves it |
| `sources/` and the archives | frozen historical artifacts; changing them breaks `verify:sources`, which is the point of freezing |

Do **not** "fix" this with a global replace.
