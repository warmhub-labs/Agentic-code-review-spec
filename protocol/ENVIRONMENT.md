# Environment

An inventory of what exists on this machine. **Not a recommendation.**

Substrate choice — which provider, which models, library or subprocess, how many
distinct models across the council — is yours, and it is one of the design
decisions this experiment is measuring. Record what you chose and why in
`DECISIONS.md`.

An earlier version of this file recommended a specific tool and mapped the
persona contract onto its flags. That was a mistake: it did the design work the
specification is supposed to convey, so the run measured nothing about whether
`spec/03-council.md` §3.4 is implementable. This file now states what is
installed and stops.

---

## Model access

**There are no provider API keys in the environment.** Model access is through
CLIs that are already authenticated.

| Tool | Status |
|---|---|
| `pi` | v0.80.10, installed, authenticated. Non-interactive mode available. |
| `claude` | installed, authenticated |
| `codex` | installed, authenticated |
| `ollama` | installed (local weights) |

Each has its own interface, its own structured-output story, and its own
approach to tool exposure, session persistence, and token accounting. Read their
`--help` and decide. The differences are real and they bear directly on parts of
the spec — how you obtain schema-conforming output, whether per-reviewer cost is
measurable or must be estimated, and whether the transcript-salvage path in
`spec/07-failure-and-coverage.md` §7.4 is reachable at all.

`spec/08-ports.md` §8.2 states the specification's own position on library
versus subprocess integration, and what a subprocess costs you. Weigh that
yourself against what is actually available.

Verified reachable at handoff: a trivial prompt through `pi` against
`openai-codex/gpt-5.4` returns correctly. That is a connectivity check, not an
endorsement of that tool or that model.

### Models

Catalogs differ per tool; enumerate them yourself. As of handoff the reachable
set spans OpenAI-Codex (`gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`, `gpt-5.6-*`),
Anthropic (`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`,
`claude-haiku-4-5`), a broad OpenRouter catalog including Google, xAI and
Moonshot models, and local weights via `llama-cpp` and `ollama`.

Nothing requires a single provider. `spec/03-council.md` §3.4 puts model and
reasoning depth in persona front matter specifically so a council can be
heterogeneous — whether that is worth doing is your call.

---

## Cost and time

Evaluation runs under a **$5.00 per review** cap and a **900-second** wall-clock
cap (`protocol/scoring.md` §4). Exceeding either zeroes the score outright, with
no partial credit. These are design constraints, not surprises to discover at
scoring time.

If your substrate cannot report per-call cost, you will have to estimate it.
Estimation is acceptable; say so in `DECISIONS.md` and state your method.

`spec/07-failure-and-coverage.md` §7.9 requires cost and duration to be recorded
for **failed** reviewers too, not only successful ones.

---

## Runtime

- `bun` 1.3.10 and `node` are available. `git` is available.
- Corpus cases are real git repositories. The unified diff is already in the
  request; the repository is there if you want it.
- Assume no network access beyond the model CLIs.
