window.FENCE_EXPLANATION_CONTRACT = {
  "schema_version": 1,
  "source": [
    "core/src/gates/placeholder-audit.ts",
    "core/src/gates/lint-primitives.ts"
  ],
  "sample": "```md\nsample\n```md\n## Runtime Variables\n- [[A]] = the thing\n```\n\nUse [[A]] now.",
  "readers": {
    "old": {
      "lines": [
        {
          "t": "```md",
          "state": "open",
          "note": null
        },
        {
          "t": "sample",
          "state": "in",
          "note": null
        },
        {
          "t": "```md",
          "state": "close",
          "note": [
            "marked-bad",
            "← wrongly closes"
          ]
        },
        {
          "t": "## Runtime Variables",
          "state": "live",
          "note": null
        },
        {
          "t": "- [[A]] = the thing",
          "state": "live",
          "note": null
        },
        {
          "t": "```",
          "state": "open",
          "note": null
        },
        {
          "t": "",
          "state": "in",
          "note": null
        },
        {
          "t": "Use [[A]] now.",
          "state": "in",
          "note": null
        }
      ],
      "declared": [
        "A"
      ],
      "used": [
        "A"
      ],
      "verdict": "PASS",
      "gate_message": "Every runtime key used is declared."
    },
    "new": {
      "lines": [
        {
          "t": "```md",
          "state": "open",
          "note": null
        },
        {
          "t": "sample",
          "state": "in",
          "note": null
        },
        {
          "t": "```md",
          "state": "in",
          "note": [
            "marked-good",
            "← content, not a close"
          ]
        },
        {
          "t": "## Runtime Variables",
          "state": "in",
          "note": null
        },
        {
          "t": "- [[A]] = the thing",
          "state": "in",
          "note": null
        },
        {
          "t": "```",
          "state": "close",
          "note": null
        },
        {
          "t": "",
          "state": "live",
          "note": null
        },
        {
          "t": "Use [[A]] now.",
          "state": "live",
          "note": null
        }
      ],
      "declared": [],
      "used": [
        "A"
      ],
      "verdict": "FAIL",
      "gate_message": "Undeclared runtime key(s): A. Declare them under a Runtime Variables heading."
    }
  }
};
