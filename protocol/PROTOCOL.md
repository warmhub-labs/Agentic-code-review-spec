# Experimental Protocol

**Implement the specification from natural language, then measure whether the
result finds the defects it should**

---

## The question

> Given only the natural-language specification in `spec/`, can a capable agent
> build a code review system that finds a known set of defects and reports them
> in a known structure — and how does what it builds compare, on the same
> evidence, to the reference implementation?

This is deliberately a **specification-sufficiency** experiment, not a
model-capability benchmark. A failure is as likely to mean "the spec was
underdetermined at point X" as "the implementer was weak," and the protocol is
designed to tell those apart.

---

## Design commitments

### The evidence is fixed; the system varies

Every candidate runs against the identical corpus of review requests. No
candidate sees a case the others did not. This makes the comparison a
measurement of the system rather than of the sample.

### Labeled public set, hidden blind set

Three splits, distinguished by who may see the ground truth.

| Split | Ground truth | Purpose |
|---|---|---|
| `public` | **shipped to the implementer**, with a scorer | Their legitimate iteration loop |
| `dev` | hidden | Our iteration set, for tuning the harness |
| `blind` | hidden, sealed | The only split whose numbers are reported |

This is the standard blind-testing shape and it is strictly better than
withholding everything. Withholding all labels gives the implementer no way to
self-check, makes any accidental leak catastrophic, and measures something no
real team experiences — nobody builds a review system without examples of what
it should catch.

Handing over a labeled subset instead makes the leak problem vanish by
construction: the public set is *supposed* to be seen, so contamination of it
costs nothing.

**The public set deliberately covers only a subset of the defect classes.** The
classes it omits are the experiment. Recall is reported two ways:

- **Seen recall** — classes the public set teaches. Measures competent execution.
- **Unseen recall** — classes it does not. Measures whether the system was built
  from the specification or fitted to the examples.

The **gap between them is the headline result.** A system that scores well on
seen classes and poorly on unseen ones has demonstrated example-fitting, and no
aggregate that blends the two would show it.

Note what is public by necessity: the routing policy names the personas, so the
**lane** taxonomy is visible — it has to be, since routing declares the council.
What is withheld is the **defect-class** taxonomy and every specific mechanism.
Building a lane the policy declares but no public case exercises is exactly the
behavior the unseen measurement rewards.

### Blinding is enforced by construction

`make-workspace.ts` assembles the workspace and then audits it, by filename and
by content, against a forbidden-token list **derived from the hidden corpus at
build time** — hidden case ids, classes exclusive to hidden splits, and decoy
rationales. A hand-maintained list goes stale the moment a case is added, and it
goes stale silently.

This check exists because an earlier version did not have it. The workspace
shipped `truth.schema.json` alongside the wire contracts — a directory copy, not
a deliberate choice — and that file enumerates every defect class. The
filename-only check in place at the time passed it. Schemas are copied by
explicit allowlist now.

### Blind is spent once

The **blind split is run exactly once** per candidate, and that run is the
reported result. A second run invalidates it: after the first, information about
the blind set has entered the loop and it is development data.

If a candidate is revised after its blind run, it needs fresh cases. Keep spare
unseeded cases in reserve for exactly this.

### One axis at a time

When iterating on a candidate, change one control variable per cycle. Depth,
council composition, model, prompt — each moves alone, with a fresh score. Two
simultaneous changes produce a result you cannot attribute, and attributing it
afterward requires re-running both.

### Clean cases carry equal weight

The corpus contains cases with **no seeded defect**. Without them, "found more
things" and "made more noise" are the same measurement, and the value axis is
unscoreable. Do not treat the clean suite as optional; it is the denominator of
every precision claim.

### Every run is retained in full

Per-reviewer raw output, coordinator raw output, routing decision, telemetry.
When a candidate regresses, the first question is whether the finding
disappeared before or after adjudication — and only per-reviewer retention can
answer it. Those two failures have opposite fixes.

---

## Phases

### Phase 0 — Provision and self-test

Establish that the corpus itself is sound before any candidate touches it.

```bash
cd harness
bun install
bun run seed          # generate cases from templates + defect library
bun run verify        # self-test the corpus
```

`verify` asserts:

1. Every case has a structurally complete `ReviewRequest` with a non-empty diff.
2. Ground-truth anchors resolve: every `truth.json` path and line range exists
   in the head tree.
3. `outside_diff` is truthful **in both directions** — a defect so marked really
   is outside every hunk, and one not so marked really is inside one.
4. Every mechanically-verifiable defect's `verification_command` succeeds against
   the head tree.
5. Every `reasoned` defect carries a written rationale of real length.
6. Clean cases seed no defects; defective cases seed at least one.
7. Case ids are unique across splits.
8. The corpus digest is reproducible.

**What it does NOT do.** It does not build the fixture project and it does not
execute its test suite. The fixture is TypeScript whose tests import `.js`
specifiers; it is written to be *read* by a reviewer, not run. An earlier version
of this document claimed otherwise, and the claim went unexamined until a
candidate flagged a corpus test that asserted its own fixture's metadata and
never called the function it named. The test was vacuous, the reviewer was right,
and nothing in Phase 0 would ever have caught it — because nothing in Phase 0
runs anything.

The consequence is worth stating plainly: for defect classes whose ground truth
is `reasoned` rather than `mechanical`, **the corpus is only as good as its
review**. Treat a candidate that disputes a case as evidence about the case, not
only about the candidate.

**Gate.** A corpus that fails self-test is not evidence. Fix it before
proceeding. A ground-truth entry that cannot be verified mechanically and has no
written rationale is removed, not assumed.

---

### Phase 1 — Implement

Construct the implementer's workspace:

```
workspace/
├── spec/                    # copied verbatim
├── schema/                  # the four wire contracts, by explicit allowlist
├── public/                  # labeled cases: request + repo + truth.json,
│                            #   two of them with a worked ReviewResult
├── score-public.ts          # scorer over the public cases only
├── ENVIRONMENT.md           # neutral inventory of the machine
└── README.md                # the implementer brief
```

```bash
bun harness/src/make-workspace.ts --out <dir> --force
```

The hidden splits, the real scorer, and any reference implementation are **not
present**, and the builder refuses to emit a workspace that mentions them.

Hand the agent `protocol/implementer-brief.md`. Record: model, harness,
reasoning settings, wall-clock, token spend, and the number of clarifying
questions it had to resolve on its own.

**Deliverable.** An executable satisfying the CLI contract:

```bash
<candidate> review --request <path/to/review-request.json> \
                   --out <path/to/review-result.json> \
                   --artifacts <dir>
```

Exit 0 on a completed review — **including one that reports failures**. Non-zero
only when no result could be produced at all.

**Gate.** The candidate produces a schema-valid `ReviewResult` for both worked
examples.

---

### Phase 2 — Conformance

Deterministic, fake-backed, no model calls, seconds not minutes.

```bash
bun run conformance --candidate <path>
```

Runs every hard gate in `spec/09-conformance.md` (C-01 … C-63; C-52 … C-60 only
on the multi-turn track).

**Gate.** All applicable hard gates pass. A candidate that fails any gate does
not proceed — its defect-finding score would be uninterpretable, because the
score presumes the result means what it says.

Record which gates failed on the first attempt and what spec text the implementer
cited when fixing them. **This is the primary spec-quality signal in the whole
protocol.** A gate that many independent implementers fail on the first pass is
underspecified, and the fix belongs in the spec, not in the implementations.

---

### Phase 3 — Development-set evaluation

```bash
bun run evaluate --candidate <path> --split dev --tag <run-tag>
bun run score    --tag <run-tag>
```

Reports every axis in `protocol/scoring.md`: per-class recall, aggregate recall,
false-positive rate on clean cases and decoys, severity calibration, routing
accuracy, anchor quality, coverage honesty, cost, latency.

**Report per-class recall before aggregate recall, always.** An aggregate hides a
missing lane: a candidate at 70% overall may be at 0% on migration safety, and
the aggregate will not say so.

---

### Phase 4 — Iterate

Optional, bounded, dev split only.

Rules:

- One axis per cycle.
- Declare the hypothesis before the run. "Adding a migration lane recovers the
  three missed migration defects" is a hypothesis; "try making it better" is not.
- Re-run conformance after every change. Prompt edits break contracts.
- Cap the cycles and state the cap. An uncapped loop turns the dev split into
  the holdout.

**When the system misses a defect class, add a lane. Do not deepen an existing
reviewer.** Depth does not buy coverage of a category a reviewer was never
scoped to; see `spec/00-overview.md` P4.

**Where the miss happened matters more than that it happened.** Before changing
anything, check the retained per-reviewer output:

- The finding is in a reviewer's candidates but absent from the final result →
  adjudication dropped it. Investigate dedup and suppression.
- The finding is in no reviewer's candidates → discovery failed. Investigate
  lane scope — most often a newly-added persona's hard fence caused an existing
  reviewer to defer.

Diagnosing from final output alone will send you to the wrong fix roughly half
the time.

---

### Phase 5 — Blind set

```bash
bun run evaluate --candidate <path> --split blind --tag <run-tag>-blind
bun run score    --tag <run-tag>-blind --final
```

**Once.** The harness records that the blind set was consumed for this candidate
identity (a hash of its source tree) and refuses a second run against the same
identity without an explicit override flag that is itself recorded in the report.

**Gate.** Report blind-set numbers as the result, split into seen and unseen
recall. Public-set and dev-set numbers are process telemetry and are reported as
such — never as the headline.

---

### Phase 6 — Report

`harness/reports/<run-tag>.md`, containing:

1. **Provenance** — spec version, corpus version and digest, candidate identity
   hash, implementer model/harness/settings, dates.
2. **Conformance** — gates passed, gates failed on first attempt, spec sections
   the implementer had to interpret.
3. **Blind results** — every axis; per-class recall first, grouped into seen and
   unseen, with the generalization gap stated explicitly.
4. **Reference comparison** — the same axes for the reference implementation on
   the same corpus, when available.
5. **Spec-quality findings** — every point of genuine ambiguity, with the
   proposed spec amendment. This is the deliverable that improves the artifact.
6. **Cost accounting** — implementation cost, evaluation cost, per-review cost.

---

## Optional tracks

### Multi-turn

Cases carrying a sequence of head revisions and a prior ledger. Adds gates
C-52 … C-60 and measures convergence: turns to halt, findings reversed,
findings republished after being fixed, P3 volume after turn 1.

Turn-alignment is mandatory when comparing against a reference: score a
candidate's turn-1 output against the reference's turn-1 output, never against
its cumulative-across-turns set. Comparing one turn to a union guarantees a
recall gap that does not exist.

### Ablation

Each reviewer alone against the full corpus, to measure true marginal
contribution per lane. This is the **only** valid basis for a subtractive routing
change, and it is the reason attribution from a full-council run cannot be used
for that purpose — see `spec/05-findings-contract.md` §5.9.

### Head-to-head against the reference

Structural comparison of two finding sets: match on path, category, and line
proximity within a stated tolerance; report matched, candidate-only,
reference-only, and severity drift.

Two cautions:

- **Match structurally, and know what the matcher misses.** Same-line
  differently-worded findings about one bug match; same-wording findings about
  different lines do not. State the tolerance and treat the matcher itself as a
  measured component — a recall number is sensitive to where you set the
  boundary.
- **Filter the reference to the candidate's declared scope before computing
  recall.** Scoring a deliberately-scoped component against an unscoped
  reference's full output measures correct scope discipline as capability
  failure. The tell-tale symptom is a stable hard zero that does not move under
  *any* candidate-side lever — that pattern means the target is out of scope or
  misattributed, not unreached.

---

## Interpreting results

| Observation | Likely meaning | Next step |
|---|---|---|
| Conformance failures cluster on one gate across independent candidates | Spec defect | Amend the spec; re-run |
| High aggregate recall, one class at zero | Missing lane | Add a reviewer for that class; confirm via per-reviewer output that no existing lane was emitting it |
| High recall, high false-positive rate on clean cases | Council over-reports and the coordinator is not verifying | Strengthen the verification mandate before touching reviewer prompts |
| Findings present in reviewer output, absent from result | Adjudication is dropping them | Investigate dedup and suppression |
| Findings absent from all reviewer output after a composition change | A new lane's fence caused an existing reviewer to defer | Investigate lane boundaries |
| Good recall, poor anchor quality | Reviewers reason from the diff without opening files | Strengthen the tool-use mandate; check the sandbox actually works |
| Routing accuracy below perfect | Policy or glob-semantics bug | Deterministic; fix directly. Never tune a model to compensate for routing |
| Cost cap exceeded with strong recall | A real trade-off | Report both. Do not silently relax the cap |
| Seen recall high, unseen recall low | Fitted to the public examples rather than built from the spec | Report the gap; it is the headline. Check whether lanes the policy declares were actually built |
| Recall improves only on the public split | Overfitting | The blind set is the answer; do not re-run it |

---

## What this protocol does not measure

Stated plainly, because these are the claims the results will be
over-extended to support:

- **Real-world false-positive rate.** Seeded decoys are a proxy. Real
  false positives arise from context a synthetic corpus does not contain.
- **Performance on defect classes not in the library.** The corpus measures what
  it seeds. A candidate scoring perfectly has demonstrated coverage of ten
  classes, not of code review.
- **Field escapes.** Defects that reach production after a clean review are the
  only ground truth about false negatives, and no offline corpus contains them.
  This is why `spec/08-ports.md` §8.7 makes the evidence ledger a first-class
  port: a system evaluated only on historical recall hill-climbs toward
  reproducing its own past behavior, blind spots included.
- **Convergence on real dialogue.** The multi-turn track uses synthetic author
  replies. Real authors argue in ways a corpus does not anticipate.
