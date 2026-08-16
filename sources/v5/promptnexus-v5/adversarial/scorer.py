#!/usr/bin/env python3
"""adversarial/scorer.py — deterministic adversarial-resilience scoring.

Given a compiled prompt, score how much of the corpus (adversarial/corpus.json) its
own anti-override language would defend against, per surface. This is the mechanical
half of framework §8's adversarial benchmark: it discharges the promise to *run* a
test set, and produces a number where before there was only `[ASSUMPTION:adversarial_untested]`.

It is explicitly NOT ground truth. A prompt "defends" a surface when it contains
language matching that surface's defense signals — a substring proxy for the property,
identical in spirit to GUARDRAIL_GAP. It over-credits (mentioning a defense counts as
having it) and cannot tell a real rule from a comment. The semantic gate tier judges
the property properly; this gives a fast, offline, deterministic floor that both the
CLI and the browser compute identically.

    from scorer import score_resilience
    result = score_resilience(compiled_prompt_text)
    # -> {"score": 0.83, "by_surface": {...}, "undefended_surfaces": [...], "total_cases": 30}

Interpretation: score is the fraction of corpus cases whose surface the prompt defends.
A surface with zero defense signal fails every case on that surface at once — which is
the point, because an undefended surface is a single systemic hole, not N small ones.
"""
from __future__ import annotations

import copy
import json
import os
import re
from functools import lru_cache

CORPUS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus.json")


@lru_cache(maxsize=1)
def _corpus_cached(path: str) -> dict:
    """Parse once per path. The result is shared, so nothing may mutate it.

    `path` is deliberately required. With a default, `f()` and `f(DEFAULT)` are
    distinct cache keys, so the same corpus was parsed and stored twice — and at
    `maxsize=1` the two keys evicted each other, turning the cache into a
    guaranteed miss and a fresh file read on every alternation. Requiring the
    argument makes one logical corpus one key.
    """
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_corpus(path: str = CORPUS_PATH) -> dict:
    """The corpus, safe to keep and safe to modify.

    An `lru_cache` hands every caller the *same* object, so a caller that
    inspects the corpus and edits it silently changes every later score in the
    process — and `serve.py` is exactly such a long-running process. Nothing in
    the tree mutates it today, which makes this a latent hazard rather than a
    live bug; the fix is cheap enough (~0.12 ms) that waiting for it to become
    live is the wrong trade.

    Internal scoring uses `_corpus_cached` directly and provably does not
    mutate, so the hot path keeps the cache and pays nothing.
    """
    return copy.deepcopy(_corpus_cached(path))


def _defends_surface(prompt_low: str, signals: list) -> list:
    """Return the signals from this surface that the prompt matches."""
    hits = []
    for sig in signals:
        try:
            if re.search(sig, prompt_low, re.I):
                hits.append(sig)
        except re.error:
            if sig.lower() in prompt_low:  # tolerate a non-regex signal
                hits.append(sig)
    return hits


def score_resilience(prompt: str, corpus: dict | None = None) -> dict:
    """Score a compiled prompt against the adversarial corpus.

    A case is 'defended' iff the prompt shows >=1 defense signal for that case's surface.
    Surfaces are scored independently so an undefended surface reads as one systemic gap.
    """
    corpus = corpus or _corpus_cached(CORPUS_PATH)
    signals = corpus["defense_signals"]
    cases = corpus["cases"]
    low = prompt.lower()

    real_surfaces = {c["surface"] for c in cases}  # ignore _comment / doc keys in defense_signals
    surface_defended = {s: bool(_defends_surface(low, sigs))
                        for s, sigs in signals.items() if s in real_surfaces}

    by_surface = {}
    defended_total = 0
    for surface in sorted(real_surfaces):
        surface_cases = [c for c in cases if c["surface"] == surface]
        n = len(surface_cases)
        defended = n if surface_defended.get(surface) else 0
        defended_total += defended
        by_surface[surface] = {
            "cases": n,
            "defended": defended,
            "signals_present": _defends_surface(low, signals[surface]),
        }

    total = len(cases)
    undefended = [s for s, ok in surface_defended.items() if not ok and by_surface[s]["cases"]]
    return {
        "score": round(defended_total / total, 3) if total else 0.0,
        "defended": defended_total,
        "total_cases": total,
        "by_surface": by_surface,
        "undefended_surfaces": undefended,
    }


def format_report(result: dict) -> str:
    lines = [f"adversarial resilience (deterministic proxy): "
             f"{result['defended']}/{result['total_cases']} cases "
             f"({result['score']:.0%})"]
    for surface, d in result["by_surface"].items():
        mark = "ok  " if d["defended"] else "GAP "
        lines.append(f"  {mark} {surface:<7} {d['defended']}/{d['cases']} "
                     f"— {'signals: ' + ', '.join(s.split(chr(92))[0][:22] for s in d['signals_present'][:2]) if d['signals_present'] else 'no defense signal found'}")
    if result["undefended_surfaces"]:
        lines.append(f"  undefended surfaces: {', '.join(result['undefended_surfaces'])} "
                     f"(each is one systemic hole, not N small ones)")
    lines.append("  NOTE: substring proxy, not proof — the semantic gate judges the property. "
                 "Absent that, prefer [ASSUMPTION:adversarial_untested] over a resilience claim.")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print("usage: python3 scorer.py <compiled_prompt.md> [--json]", file=sys.stderr)
        sys.exit(2)
    text = sys.stdin.read() if sys.argv[1] == "-" else open(sys.argv[1], encoding="utf-8").read()
    res = score_resilience(text)
    print(json.dumps(res, indent=2) if "--json" in sys.argv else format_report(res))
