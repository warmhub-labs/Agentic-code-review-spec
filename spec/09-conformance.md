# Part 9 — Conformance

**What an implementation is graded against**

---

## 9.1 Two kinds of criteria

**Hard gates (§9.2)** are contract violations. Any single failure means
non-conformance, regardless of how well the system finds defects. They are all
checkable deterministically, with fakes, in milliseconds.

**Graded criteria (§9.3)** measure defect-finding performance against the seeded
corpus. They produce a score.

The asymmetry is intentional. A system that finds every defect but cannot be
trusted to report when it did not run is worse than useless, because its silence
is indistinguishable from a clean review. Contract correctness is a
precondition, not a trade-off.

---

## 9.2 Hard gates

Each maps to an automated check in `harness/src/conformance.ts`. `C-` prefixed
identifiers are record labels for the checklist, not a taxonomy to learn.

### Contracts

| # | Gate |
|---|---|
| C-01 | `ReviewResult` validates against the schema for every corpus case, including failure cases. |
| C-02 | Unknown fields in `ReviewRequest` are ignored, not rejected. |
| C-03 | Severity values outside `P0..P3` are rejected, never coerced. |
| C-04 | Category values outside the ten are rejected, never coerced. |
| C-05 | Coordinator output containing an `id` field is rejected. |
| C-06 | Coordinator output missing any of the seven required top-level keys is rejected. |
| C-07 | Reviewer output with `reviewed` ≠ boolean `true` is recorded as a failure, not an empty result. |
| C-08 | Reviewer output missing `summary`, or with `summary` under the minimum length, is a failure. |
| C-09 | Reviewer output missing or non-array `audit_rows_reviewed` is a failure. |

### Routing

| # | Gate |
|---|---|
| C-10 | Routing is pure: identical changed-file list plus identical policy yields a byte-identical dispatch plan across repeated invocations. |
| C-11 | Highest-tier-wins: one critical-pattern file makes the whole change critical. |
| C-12 | Promote-only: no path demotes a change below its static floor. |
| C-13 | A subtractive (`every`) override does not fire on a mixed-content change. |
| C-14 | An additive (`any`) override fires when at least one file is in scope, at every tier it applies to. |
| C-15 | An override with its kill switch off never fires. |
| C-16 | A subtractive override does not fire when the deterministic audit reports a P0 or P1 row. |
| C-17 | No override fires on an empty changed-file list. |
| C-18 | A missing required tier entry in the policy fails loudly rather than defaulting. |

### Coverage honesty — the load-bearing set

| # | Gate |
|---|---|
| C-19 | `coverage.declared` is populated from the dispatch plan, not from what was attempted. |
| C-20 | A reviewer that fails appears in `coverage.failed` with a reason. |
| C-21 | `coverage.complete` is `false` whenever any reviewer failed, the deadline was exceeded, or the coordinator source is a fallback. |
| C-22 | A run with `coverage.complete: false` never renders as an unqualified clean review. |
| C-23 | A deadline-fallback result never reports `overall_rating: CLEAN`. |
| C-24 | Salvage never fabricates `reviewed: true`. |
| C-25 | Salvaged reviewers are recorded with a distinct status. |
| C-26 | Declared-versus-returned mismatch is emitted as a distinct event, separate from the failure list. |
| C-27 | Publication truncation is stated in the result whenever it occurs. |
| C-28 | Per-reviewer telemetry — duration and cost — is recorded for failed reviewers, not only successful ones. |

### Anchors and publication

| # | Gate |
|---|---|
| C-29 | An anchor whose line is outside every diff hunk is `file_only`, and publishes to summary only when severity ≥ P2 and PR-causation is affirmed. |
| C-30 | An anchor on a nonexistent path is `unanchorable`, suppressed, and logged as a coordinator error. |
| C-31 | An anchor on a file no longer in the diff is `stale` and never publishes inline. |
| C-32 | `start_line` without `start_side` is rejected. |
| C-33 | `start_line > line` is rejected. |
| C-34 | P3 findings are capped on the first turn and hard-capped to zero thereafter. |
| C-35 | A suppressed finding still appears in the result, with `published: false` and a reason. |
| C-36 | The published overall rating is recomputed from the surviving finding set, not taken from the coordinator's assertion. |

### Invariants

| # | Gate |
|---|---|
| C-37 | P3 never blocks. |
| C-38 | Suppressed findings never block. |
| C-39 | A waived finding blocks unless the waiving actor is authorized for that severity. |
| C-40 | A silent reversal — a previously published finding simply absent, with no reversal record — is rejected. |
| C-41 | A superseded finding points at its replacement. |
| C-42 | A finding marked `fixed` carries verification evidence or a deterministic reason. |
| C-43 | Finding `id` is immutable once assigned. |
| C-44 | An undischarged audit row is re-emitted at its rule-declared severity. |

### Security

| # | Gate |
|---|---|
| C-45 | A secret in change-added content produces a P0 before any model call. |
| C-46 | The model-bound diff contains a redaction marker in place of the secret line. |
| C-47 | The secret value appears nowhere in the finding, result, logs, or persisted artifacts. |
| C-48 | Injection content on a trusted-instruction surface produces a P1. |
| C-49 | Injection content on an artifact surface produces **no** finding. |
| C-50 | Instructions in change-modified instruction files do not alter reviewer behavior for the current review. |
| C-51 | Workspace path traversal and out-of-root symlinks are refused, returning structured markers rather than exceptions. |

### Multi-turn (Part 6 — required only for the multi-turn track)

| # | Gate |
|---|---|
| C-52 | Same content key and same interaction key → skip; no model call; nothing published. |
| C-53 | Same content key, changed interaction key → author-response state; no new findings. |
| C-54 | A squash producing an identical tree → skip, despite the changed head revision. |
| C-55 | A policy-hash change → re-review, despite an unchanged head revision. |
| C-56 | Skips and escalations append to run history and do not advance the round. |
| C-57 | Ledger merge is idempotent. |
| C-58 | The ledger projection never exceeds the tier's token cap; open findings, disputes, and reversal history are never dropped. |
| C-59 | A stale digest on save aborts publication. |
| C-60 | Turn budget exhausted with open blockers → escalation, never auto-approve. |

### Retention

| # | Gate |
|---|---|
| C-61 | Per-reviewer raw output is retained separately from the coordinator's output for every run. |
| C-62 | The routing decision — tier, matched rules, fired overrides — is recoverable from the run record. |
| C-63 | Reviewer summaries are retained and rendered even for reviewers with zero candidates. |

### Amendment gates

These close requirements added after the four-implementation experiment. Several
earlier amendments shipped as prose with no gate; an unenforced MUST is a
suggestion, and the asymmetry those amendments were written to remove survives
in the instrumentation until a gate names it.

| # | Gate |
|---|---|
| C-64 | The reviewer process receives an explicit environment allowlist, not the orchestrator's environment. A variable absent from the allowlist is absent from the child. |
| C-65 | The implementation declares which §1.7 approach it uses — interposed port or prepared tree — and the live reviewer read path actually goes through it. |
| C-66 | A credential-shaped literal on an artifact surface (test fixture, documentation example, recorded cassette) produces no secret finding. |
| C-67 | Audit rows are discharged by the composite `"<source>: <label>"` key; two rows sharing a label across different sources are distinct discharges. |
| C-68 | A multi-line anchor whose `start_line` falls outside a diff hunk resolves to `file_only`, never `current_diff`. |
| C-69 | `candidates_undischarged` is present and correct: a council candidate the coordinator neither promoted nor suppressed increments it. |
| C-70 | A coordinator failure produces exactly the §7.8.1 shape — `outcome: failed`, `coordinator_ran: false`, `coordinator_source: "none"`, `complete: false`, never `CLEAN`, council candidates suppressed with reason `coordinator_failure`. |
| C-71 | `coverage.complete` is false when `coordinator_source` is `"none"`, matching the §7.6 formula. |
| C-72 | Adapter retries are bounded by a declared maximum, and every attempt's duration and cost appears in that reviewer's `telemetry.per_persona` entry. |
| C-73 | A finding merged from multiple candidates carries every contributing `candidate_ref` in `merged_candidate_refs`, including its own. |

---

## 9.3 Graded criteria

Measured by `protocol/PROTOCOL.md` against the seeded corpus. Full definitions
in `protocol/scoring.md`.

| Axis | Measures | Why it is separate |
|---|---|---|
| **Per-class recall** | Fraction of seeded defects found, **broken out by defect class** | An aggregate number hides a missing lane. A system at 70% overall may be at 0% on migrations. |
| **Aggregate recall** | Overall seeded-defect recall | The number that ships |
| **False-positive rate** | Findings at P2 or above on clean cases and on decoys | Recall alone is unscoreable as value. Without a clean suite, "found more things" and "made more noise" are the same measurement. |
| **Severity calibration** | Agreement between reported and ground-truth severity on matched defects | A system that finds everything at P3 has not found anything |
| **Routing accuracy** | Correct tier, correct override firing, correct council composition | Deterministic; should be near-perfect. Anything else is a policy bug. |
| **Coverage honesty** | Correct `coverage.complete` under injected reviewer failures | Hard-gated too; graded here for degree |
| **Anchor quality** | Fraction of published anchors that resolve to `current_diff` | A correct finding on an unresolvable anchor cannot be acted on |
| **Cost** | USD per review | — |
| **Latency** | Wall clock per review | The number a human or agent waits on. Report the distribution, not the mean. |

**Scoring gates.** A candidate scores zero — no partial credit — when it exceeds
the cost cap, exceeds the wall-clock cap, or falls below the reviewer-completion
threshold. Recall bought by ignoring the budget is not recall; it is a different
system.

---

## 9.4 The minimum viable implementation

For the single-turn evaluation track:

**Required:** Parts 1–5, Part 7, and the hard gates C-01 … C-51 and C-61 … C-63.
Ports: `ModelAgent` and `Workspace` real; everything else may be a no-op fake.

**Not required:** the multi-turn state machine, the ledger, the projection,
publication to a hosting platform, telemetry export, and the evidence ledger.

This is a genuinely useful system on its own: given a change, it routes,
assembles a council, adjudicates, and returns structured findings with an honest
coverage report.

**Add for production:** Part 6 (state machine, ledger, halting) and the
`ChangeProvider`, `LedgerStore`, and `TelemetrySink` ports. The multi-turn
machinery is what stops the review from diverging across rounds, and it is
unnecessary until reviews actually run more than once per change.

**Add for the loop to compound:** `EvidenceLedger` (Part 8 §8.7). Without it the
system is a good reviewer. With it, the system's stochastic spend converts into
deterministic checks over time — which is the difference between a cost and an
investment.
