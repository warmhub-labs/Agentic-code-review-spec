# Council Review — Natural-Language Specification

**Part 0 of 9 — Overview, scope, and design principles**

---

## What this specifies

A **multi-agent code review system** that takes a proposed change to a codebase
and returns a structured set of defect findings, together with an honest account
of how much review actually happened.

The system's shape: deterministic code decides *how much attention a change
deserves* and *what gets published*; a dynamically assembled set of
model-driven reviewers proposes defect hypotheses; a single strong adjudicator
verifies and disposes of them. Everything stochastic is surrounded by things
that are not.

This document is written to be implemented from scratch, in any language, by a
competent engineer or agent that has never seen the reference implementation.
It describes **behavior and contracts**, not code structure. Where a contract
must be exact, it is given as JSON Schema; everything else is prose with
explicit MUST / SHOULD / MAY obligations.

## The contract boundary

The specification stops at two wire contracts:

```
   ReviewRequest  ─────►  [ the system you are building ]  ─────►  ReviewResult
   (Part 1)                                                        (Part 5)
```

**In scope.** Everything between those two contracts: risk classification,
packet preparation, council assembly, the reviewer prompt contract, coordinator
adjudication, evidence anchoring, publication policy, the review state machine,
the finding ledger, and coverage/failure accounting.

**Out of scope — deliberately.** How a `ReviewRequest` is produced from a real
code-hosting platform, and what is done with a `ReviewResult` afterward. Posting
comments to a pull request, resolving review threads, writing a durable
telemetry ledger, and emitting traces are all real parts of a production
deployment, and they are specified here only as **ports** — named interfaces
with defined obligations (Part 8) — not as implementations. An implementation
that satisfies this spec with in-memory ports is complete and testable.

This boundary is the point. It makes the system portable across hosting
platforms, and it makes the system *evaluable*: given a fixed `ReviewRequest`,
a conforming implementation must find a known set of defects and report them in
a known shape. The experimental protocol in `protocol/PROTOCOL.md` exercises
exactly that.

## Reading order

| Part | File | Contents |
|---|---|---|
| 0 | `00-overview.md` | This file. Scope, principles, vocabulary. |
| 1 | `01-review-request.md` | The input contract: packet preparation and what the reviewers may see. |
| 2 | `02-risk-routing.md` | Deterministic risk classification and council assembly. |
| 3 | `03-council.md` | Reviewer roles, the persona contract, dispatch and isolation. |
| 4 | `04-coordinator.md` | Adjudication: verification, dedup, severity, reversal handling. |
| 5 | `05-findings-contract.md` | The output contract: findings, anchors, coverage, ratings. |
| 6 | `06-state-and-ledger.md` | Multi-turn state machine, finding ledger, convergence and halting. |
| 7 | `07-failure-and-coverage.md` | Failure isolation, partial results, and the honesty rules. |
| 8 | `08-ports.md` | Interfaces to the outside world: publication, ledger, telemetry, model. |
| 9 | `09-conformance.md` | The conformance checklist an implementation is graded against. |

A **minimum viable conforming implementation** needs Parts 1–5, 7 and 9. Parts 6
and 8 are required for a multi-turn production deployment and are exercised by
the protocol's optional multi-turn track.

---

## Design principles

These are load-bearing. An implementation that satisfies the letter of the
contracts while violating these will fail conformance in ways the checklist
makes explicit.

### P1 — Route before you reason

Deterministic policy decides the shape of the review *before any model spends a
token*: which reviewers run, at what depth, and which severities may be
published. Routing is a pure function of the changed file paths and a policy
document. It is the cheapest component in the system and it constrains all
downstream spend.

Corollary: routing must be **reproducible**. The same changed-file list against
the same policy MUST produce the same dispatch plan, every time, with no model
involvement.

### P2 — Deterministic code owns disposition; the model proposes

The model never assigns a stable finding identifier, never computes a
cross-turn match key, never decides whether a finding is publishable, and never
renders the final report. It emits *candidates* with response-local references.
Everything downstream of that — identity, anchoring, severity validation,
publication policy, rendering — is deterministic post-processing.

This is what makes the system testable without model calls, and what stops
prompt changes from silently changing publication behavior.

### P3 — Specialists discover; the coordinator decides

Reviewers run in **independent lanes with no cross-anchoring**: no reviewer sees
another reviewer's output, and none sees the accumulated review history. They
over-report by design. A single coordinator then verifies each candidate against
the actual code, deduplicates, normalizes severity, and disposes.

Findings are *hypotheses until verified*. One verifier that reads the cited code
and confirms the mechanism is worth more than five reviewers agreeing with each
other — agreement among reviewers who share a prior is not evidence.

### P4 — Breadth over depth in the council; depth in the adjudicator

Reviewer recall scales with **coverage breadth** — the number of independent
topic lanes — not with per-reviewer reasoning depth. Topic reviewers are
category pattern-matchers within their lane and SHOULD default to a low or
medium reasoning setting. Spend the deep-reasoning budget on the coordinator
(which must catch contradictions *across* lanes) and on adversarial roles.

The corollary is a rule about interventions: **when the system misses a defect
class, add a reviewer whose lane covers that class. Do not make an existing
reviewer think harder.** Depth does not buy coverage of a category the reviewer
was never scoped to, and over-deep topic reviewers produce confident
over-grading inside their own lane.

Two important limits on this principle, both learned the hard way:

- Procedural checklists raise a shallow reviewer on **pattern-matchable**
  defect classes (structural co-occurrence — "this workflow trigger plus this
  checkout equals a trust-boundary break"). They do **not** substitute for
  reasoning depth on data-flow or semantic correctness defects. Do not expect a
  checklist to turn a cheap lane into a strong general reviewer.
- A single unscoped, deep general reviewer is a legitimate *recall floor* lane
  alongside the topic lanes. It is expected to overlap with them; the
  coordinator dedupes. Overlap is not waste.

### P5 — A failed reviewer is never silence

Every dispatched reviewer MUST return, and MUST return something that
affirmatively states it engaged. A reviewer that crashes, times out, or returns
unparseable output is recorded as a **failure**, and the failure appears in the
result. It is never collapsed into "no findings."

**A partial pass must not be able to pose as a clean one.** This is the single
most important honesty property in the system, and it is a hard conformance
gate.

### P6 — Untrusted input is adversarial

The change under review is attacker-controlled. Diff content, file paths, commit
messages, change descriptions, and any instruction-bearing file *modified by the
change* are untrusted. Trusted instructions come only from the base revision.
Reviewers execute nothing from the change; tool access is read-only and
sandboxed. Detected secrets produce findings directly and are never echoed back.

### P7 — Every run is recorded

Cost, duration, dispatch plan, per-reviewer candidate output, coordinator
disposition, and final findings are all recorded per run. Per-reviewer
candidates are retained **separately from the final output** — when the system
regresses after a composition change, the first diagnostic question is whether
the finding disappeared before or after adjudication, and only per-reviewer
retention can answer it.

---

## Vocabulary

Terms are used precisely throughout. Where the reference system uses a
platform-specific word, the portable term is given first.

| Term | Meaning |
|---|---|
| **Change** | The unit under review: a base revision, a head revision, and the diff between them. Platform-neutral stand-in for "pull request". |
| **Review request** | The complete, deterministically-prepared input to a review run. Part 1. |
| **Packet** | The subset of the review request presented to model-driven reviewers: filtered diff, metadata, policy context, prior state. |
| **Risk tier** | The deterministic classification of a change: `critical`, `high`, `medium`, `low`. Governs how much attention the change receives. |
| **Risk floor** | The tier computed from file paths alone. Later analysis may *promote* a change to a higher tier; nothing may demote it below the floor. |
| **Dispatch plan** | The output of routing: tier, which reviewers to run, reasoning depth, publication policy, halt rules. |
| **Reviewer / specialist** | A model-driven agent with a scoped mandate that proposes candidate findings. Runs in an isolated lane. |
| **Council** | The set of reviewers dispatched for one turn. Assembled dynamically per change. |
| **Coordinator** | The single agent that verifies, deduplicates, re-rates, and disposes of candidates. |
| **Fresh-read reviewer** | A reviewer invoked at merge time with no history — deliberately un-anchored by the review dialogue. Called the *skeptic* in the reference system. |
| **Candidate** | An unverified defect hypothesis emitted by a reviewer, carrying a response-local reference. |
| **Finding** | A candidate that the coordinator has verified and disposed of, and that deterministic post-processing has assigned a stable identity to. |
| **Evidence anchor** | The location a finding cites: path, line, side, optional range and surrounding-symbol metadata. |
| **Anchor status** | How well an anchor resolves against the diff: `current_diff`, `file_only`, `stale`, `unanchorable`. Governs publication. |
| **Coverage report** | Declared-versus-returned reviewer accounting for a run. Part 5. |
| **Turn** | An engaged review invocation that ran a coordinator and possibly a council. |
| **Run** | Any invocation, including ones that skip without engaging. Runs are recorded; only turns count against budgets. |
| **Ledger** | The persistent per-change record of findings and their status across turns. |
| **Turn state** | Which kind of turn this is — first review, fix verification, author response, convergence, final fresh read, or a skip. Part 6. |

---

## Severity and category taxonomy

Fixed and closed. Implementations MUST use exactly these values.

**Severity** — four levels, ordered:

| Value | Meaning |
|---|---|
| `P0` | Exploitable or destructive right now. Credential exposure, data loss, production-down. Blocks unconditionally. |
| `P1` | A real defect that will produce wrong behavior, a security weakness, or an outage under realistic conditions. Blocks by default. |
| `P2` | A genuine defect with bounded blast radius, or a significant maintainability/testing gap. Blocking is tier-dependent. |
| `P3` | Minor: polish, hardening on an unreachable path, style with a concrete rationale. **Never blocks.** |

**Category** — ten values:

`correctness`, `security`, `performance`, `testing`, `maintainability`,
`readability`, `structure`, `audience`, `completeness`, `ci-workflow`

**Confidence** — `low`, `medium`, `high`. Confidence is the reviewer's own
assessment of whether the mechanism it describes is real. It is *not* a severity
modifier; the coordinator uses it to decide what to verify most carefully.

**Overall rating** — `CLEAN`, `MINOR_CONCERNS`, `MAJOR_CONCERNS`, `BLOCKING`.
Computed from the published finding set, not asserted independently.

---

## What "conforming" means

An implementation conforms when it passes the checklist in Part 9. That
checklist has two kinds of item:

- **Hard gates.** Contract violations. A single failure means non-conformance
  regardless of defect-finding performance. Examples: emitting a stable finding
  id from the model, reporting a partial council run as complete, publishing an
  inline finding on an anchor that does not resolve.
- **Graded criteria.** Defect-finding performance, measured by the experimental
  protocol against a seeded corpus. These produce a score, not a pass/fail.

The distinction matters: a system that finds every defect but cannot be trusted
to say when it did not run is worse than useless, because its silence is
indistinguishable from a clean review.
