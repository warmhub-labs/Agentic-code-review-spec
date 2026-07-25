# Experimental Results

**Four independent implementations built from the specification, 2026-07-24/25**

---

## The question

Given only the natural-language specification in `spec/`, can a capable agent
build a code review system that finds a known set of defects and reports them in
a known structure — and does the answer depend on which model reads it?

---

## Summary

Four agents built implementations from the spec alone, blind to a held-out
corpus. Two completed the full evaluation.

| | Run 1 | **Run 2** | **Run 3** | Run 4 |
|---|---|---|---|---|
| Implementer | fable-5 | fable-5 | opus-4.8 | gpt-5.6-sol (high) |
| Workspace | contaminated | clean | clean | clean, amended spec |
| Own conformance suite | 55/55 | 50/50 | 54/54 | built, unscored |
| Harness conformance | — | **17/17** | **17/17** | — |
| **Blind recall, seen classes** | — | **100%** | **100%** | not measured |
| **Blind recall, unseen classes** | — | **86%** | **86%** | not measured |
| **Generalization gap** | — | **14pp** | **14pp** | — |
| Blind recall P1+ | — | 100% | 100% | — |
| Clean-case false positives | — | 0% | 0% | — |
| Severity exact | — | 80% | 80% | — |
| Anchor quality | — | 95% | 72% | — |
| Routing accuracy | — | 100/100/100 | 100/100/100 | — |
| Coverage honesty | — | 100% | 100% | — |
| Cost per review (p50) | — | $0.43 | $0.40 | — |
| Composite | — | 10.36 / 12 | 10.14 / 12 | — |
| **The single miss** | — | **`doc-drift`** | **`doc-drift`** | — |

Runs 1 and 4 did not produce comparable performance numbers — run 1's workspace
leaked the defect-class taxonomy, and run 4's sandbox blocked model access so its
council never dispatched. Both still produced usable decision logs, which is
where most of the value turned out to be.

---

## Result 1 — Two independent implementations converged exactly

Runs 2 and 3 used different implementer models, chose **different substrates**
(`claude` CLI single-provider versus `pi` across three model families), and
assembled different councils. They produced identical seen/unseen recall,
identical P1+ recall, identical severity calibration, identical routing, and
**the same single miss**.

That convergence is the strongest available evidence that the specification —
rather than the implementer's priors — determined the design.

The 14pp gap is the number that matters. Both systems scored 100% on the four
defect classes the labeled public set taught them, and 86% on six classes it
never mentioned: SQL migration hazards, hardcoded secrets, CI workflow
injection, cross-file latent defects, prompt-injection surfaces, documentation
drift. A system fitted to its examples does not do that.

---

## Result 2 — The convergence is not a Claude-family artifact

Runs 1–3 were all Anthropic-family models, and the specification was written by
Claude. Two Claude models agreeing that a Claude-written document is clear is
weak evidence. Run 4 used a Codex model specifically to discriminate.

It hit **the same three unamended ambiguities** as all three Claude-family
implementers:

| Ambiguity | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|
| Glob semantics | ✓ | ✓ | ✓ | ✓ |
| Audit-row scope | ✓ | ✓ | ✓ | ✓ |
| Coordinator-failure result shape | ✓ | ✓ | ✓ | ✓ |

Four independent readers, two model families, converging on the same three gaps.
The underspecification was real and model-independent, not a dialect problem.

A second signal emerged unplanned. Run 4 built from a spec already amended after
runs 1–3, and its decision log is **7 sections against runs 2 and 3's 21 and 22**
— with the missing entries being exactly the ambiguities those amendments
targeted. The amendments were validated by a reader who never saw the broken
version.

---

## Result 3 — `doc-drift` is a specification gap, not a model failure

Both completed runs missed exactly one defect class, and both missed it the same
way: a reviewer **proposed** the finding and the coordinator silently dropped it.
Both located the loss only through per-reviewer retention (§3.7). Neither had
seen the other's work.

The cause was an asymmetry in the specification. It required every deterministic
audit row to be explicitly dispositioned and imposed no such obligation for
model-proposed candidates. Silence on a candidate was legal.

That asymmetry was never intentional. A deterministic check and a stochastic
reviewer both produce claims the adjudicator must answer for; only one had its
answer enforced. Now both do (§4.4).

This is the clearest demonstration of the protocol working as designed: a
systematic gap, reproduced independently, diagnosed to a specific clause, and
fixed — rather than being written off as one model's weakness.

---

## Result 4 — The specification contained a self-contradiction

`spec/05` §5.4 defined `file_only` as "path **touched by the change**" and
`stale` as "the file is no longer in the diff → suppress." The paragraph
immediately below defended findings on **untouched callers** as "the most
valuable findings a council produces."

The table suppressed what the rationale protected. A candidate following the
table scored zero on cross-file defects; one following the prose scored full
marks. Two implementations resolved it in opposite directions — one flagged it,
one silently chose the prose.

Resolved by separating the concepts: `stale` is now purely cross-turn (a
previously published finding whose file has left the diff); `file_only` covers
any path that exists in the repository, with affirmative causation as the
honesty control.

---

## Result 5 — Six defects in the measuring instrument, five found by the systems under test

The most unexpected result. Giving implementers a labeled public set turned them
into reviewers of the harness.

| # | Defect | Found by |
|---|---|---|
| 1 | Decoy metric measured adjacency, not error — 6 of 10 decoys sat inside the ±12 match tolerance of a real defect | Runs 1, 2, 3 |
| 2 | `C-61` and miss-diagnosis keyed on a filename the spec never mandated, failing a candidate that retained *more* than required | Run 2 |
| 3 | A "clean" corpus case contained a vacuous test asserting its own fixture's metadata | Run 2 |
| 4 | Clean-case FP scoring inverted — penalizing the more thorough reviewer for correctly flagging (3) | Run 3 |
| 5 | Unseeded real defects in the fixture: `sign()` returning `${key.slice(0,6)}:${body.length}` — fake crypto that leaks the key prefix | Run 2 |
| 6 | Completion gate punished candidates for correctly honoring an injected failure | Harness author |

Defect 3 exposed something larger: the fixture's tests import `.js` specifiers
from TypeScript sources, so **no test in the corpus was ever executable** — while
`PROTOCOL.md` claimed Phase 0 verified that they passed. The claim was written as
fact and never implemented.

The decoy metric was ultimately **demoted to advisory and removed from the
composite**. Structural proximity cannot distinguish "flagged the decoy" from
"found a different real defect nearby," and in a realistic fixture there is
always something real nearby. It is reported for manual adjudication only.

---

## Threats to validity

**Corpus scale.** Eleven blind cases, seven unseen-class defects. The 14pp gap
rests on a single miss. Directionally clear, not precise.

**Single-shot.** One run per candidate per case (`k=1`); model variance is
inside the numbers. Run 2 observed severity grading vary between identical runs.

**Reasoned ground truth.** Twelve of the seeded defects are `reasoned` rather
than mechanically verifiable. Their correctness rests on review, and the corpus
was demonstrably wrong at least twice.

**Fixture realism.** A small synthetic service. Real false positives arise from
context a synthetic corpus does not contain.

**Miss-diagnosis heuristic.** The discovery-versus-adjudication field is a text
scan over retained artifacts; a reviewer that merely *read* a file can trip it.
Run 3's voided attempt produced a diagnosis that is almost certainly wrong.

**No field escapes.** Defects reaching production after a clean review are the
only ground truth about false negatives, and no offline corpus contains them.
This is why `spec/08` §8.7 makes the evidence ledger a first-class port.

**Author conflict.** The specification, corpus, and scorer share one author.
Five of six harness defects were found by the systems under test, which is
evidence the design surfaces author error — and also evidence there was author
error to surface.

---

## Cost

Roughly 1.1M subagent tokens across four implementations, and under $30 of
model spend across all evaluation runs. Per-review cost for a conforming
implementation sat at **$0.40–0.43 median**, against a $5.00 cap — with p95
latency near 150s against a 900s cap.

---

## What changed as a result

Five specification amendments, each carrying its witness count:

1. **Candidates must be explicitly discharged** (§4.4) — 2 witnesses, cost a real finding twice
2. **`file_only` versus `stale`** (§5.4) — self-contradiction, 1 witness, objectively verified
3. **Causation is a schema field**, `caused_by_change` (§5.4) — 3 witnesses, 3 incompatible prose conventions
4. **Glob semantics pinned by the spec** (§2.3) — 4 witnesses
5. **Audit-row scope defined** (§1.8) — 4 witnesses
6. **Coordinator-failure result shape specified**, `coordinator_source: "none"` (§7.8.1) — 4 witnesses

Every amendment records the evidence that produced it, in the spec text itself.
