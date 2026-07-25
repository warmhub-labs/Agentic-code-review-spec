# Council Review

**A multi-agent code review system, specified in natural language — complete
enough that an agent can build a working one from the specification alone.**

Four independent agents have done exactly that. Their results are in
[`RESULTS.md`](RESULTS.md).

Derived from the review system running in production at WarmHub, but written to
be implemented anywhere, in any language, against any model provider. Nothing
here depends on a particular code-hosting platform.

---

## Build it

Give your agent two directories and one instruction.

**Hand it:**

```
spec/      the specification — ten parts, ~18k words
schema/    the four wire contracts it must satisfy
```

`schema/` lives at `harness/schema/`; copy those four `.json` files anywhere
convenient. Nothing else in this repository is needed to build the system.

**Tell it:**

> Read every part of `spec/` before writing any code — all ten, in order. Then
> build a system satisfying the `ReviewRequest` → `ReviewResult` contract in
> `schema/`.
>
> Implement the hard gates in `spec/09-conformance.md` and provide a
> `conformance` subcommand that runs them against in-memory fakes, with no model
> provider configured. Get that suite green before you write a single prompt —
> routing, packet preparation, and deterministic post-processing are most of the
> system and none of them need a model.
>
> Required scope: Parts 1–5 and Part 7, plus gates C-01…C-51 and C-61…C-63.
> Part 6 (multi-turn state) is optional; skip it on a first build.
>
> Record every point where the specification was ambiguous or silent in a
> `DECISIONS.md`, citing the section. Where the spec states a MUST, follow it
> even if you would design it differently.

**You get:** a CLI that takes a change and returns structured findings with
evidence anchors, severity, and an honest account of how much review actually
ran.

### What "working" means

The specification ships its own acceptance test. `spec/09-conformance.md`
defines 63 hard gates — contract violations, all checkable deterministically
against fakes in about a second, with no provider and no cost. If the
conformance suite is green, the implementation is conforming.

That is the bar to aim for first. Defect-finding quality comes after, and only
means anything once the output can be trusted to say what it did.

### What it costs to run

From the four measured implementations: **$0.40–0.43 median per review**, p95
latency around 150 seconds. The specification carries budget caps of $5.00 and
900 seconds, and both were comfortable.

### Longer form

[`protocol/implementer-brief.md`](protocol/implementer-brief.md) is the fuller
brief handed to the agents whose results are in `RESULTS.md`. It includes a
"Traps" section — the things implementations get wrong, each mapped to the gate
that catches it — which is worth handing over verbatim.

Note that it is written for a *blind evaluation*, so it references a held-out
corpus and a scorer. Ignore those parts if you are just building the system.

---

## What's in here

| | What it is | You need it if |
|---|---|---|
| **`spec/`** | The specification. Ten parts, implementation-independent. | **You want a working reviewer.** This is the deliverable. |
| **`harness/schema/`** | The four wire contracts. | Same — hand these over with `spec/`. |
| **`protocol/`** | The experimental loop: implement → conform → evaluate → blind. | You want to measure how well an implementation does. |
| **`harness/`** | Corpus generator, workspace builder, scorer, conformance runner. | Same. Not needed to build the system. |
| [`RESULTS.md`](RESULTS.md) | What four independent implementations scored. | You want evidence the spec is sufficient. |
| [`DISCLAIMER.md`](DISCLAIMER.md) | **Read before relying on any of this.** | Always. This is a review aid, not a security control. |
| [`LICENSE`](LICENSE) | Apache License 2.0. | |

Most of this repository is evaluation apparatus. If your goal is a working
review system, you can ignore everything except `spec/` and the four schemas.

---

## The shape of the system

```
                deterministic                    stochastic                deterministic
  ┌───────────────────────────────┐   ┌──────────────────────────┐   ┌────────────────────┐
  │  packet preparation           │   │  council                 │   │  identity          │
  │  risk classification          │──►│    N independent lanes   │──►│  anchor validation │──► ReviewResult
  │  council assembly             │   │  coordinator             │   │  publication policy│
  │  secret + injection scanning  │   │    verify, dedupe, rate  │   │  coverage report   │
  └───────────────────────────────┘   └──────────────────────────┘   └────────────────────┘
```

The load-bearing ideas, in one line each:

- **Route before you reason.** Deterministic policy picks the review's shape
  before any model spends a token. Cheapest component; shapes all downstream cost.
- **Findings are hypotheses, not votes.** One verifier that reads the cited code
  beats five reviewers agreeing with each other.
- **Breadth beats depth in the council.** Recall scales with the number of
  independent topic lanes, not per-reviewer reasoning depth. Spend the deep
  budget on the adjudicator.
- **A failed reviewer is never silence.** A partial pass must not be able to pose
  as a clean one. This is the hardest gate in the spec and the easiest to skip.
- **The model proposes; deterministic code disposes.** No stable identifiers, no
  publication decisions, no rendering from the model — which is what makes the
  whole system testable with no provider at all.

---

Where to start reading: [`spec/00-overview.md`](spec/00-overview.md). Parts 1–5
are the core contract, Part 7 is the honesty rules, Part 9 is the conformance
checklist. Parts 6 and 8 — multi-turn state and external ports — matter for a
production deployment and can be skipped on a first build.

---

# Evaluating an implementation

**Everything below is apparatus for measuring how well an implementation
performs. None of it is needed to build one.** If you came here to hand a
specification to an agent, you are already done.

## ⚠️ This repository contains the blind corpus

The seeded-defect library in `harness/src/defects/` defines every case an
implementation is measured against — including the classes deliberately withheld
from the labeled practice set.

**An agent with access to this repository is not blind, and any recall number it
produces is meaningless.** Build the isolated workspace instead:

```bash
bun harness/src/make-workspace.ts --out /somewhere/else --force
```

That ships the specification, the four schemas, the labeled practice cases with
their ground truth, and a self-scorer — and withholds everything else. It audits
its own output by filename *and* content against a forbidden-token list derived
from the hidden corpus, and refuses to emit a workspace that mentions any of it.
That check exists because an earlier version leaked the defect-class taxonomy
through a directory copy nobody looked at twice.

If you extend the corpus, add cases to the library and regenerate. If you publish
results, say which corpus version produced them.

## Running the harness

```bash
cd harness
bun install
bun run seed        # generate the corpus — 23 cases, real git repositories
bun run verify      # self-test it; a corpus that fails this is not evidence
```

Smoke-test the pipeline against the null candidate, which implements routing and
finds nothing:

```bash
printf '#!/bin/sh\nexec bun "$PWD/src/null-candidate.ts" "$@"\n' > /tmp/nullc && chmod +x /tmp/nullc
bun src/evaluate.ts --candidate /tmp/nullc --split dev --tag null-baseline
bun src/score.ts --tag null-baseline
bun src/conformance.ts --tag null-baseline
```

It scores 0 — gated on reviewer completion — with 100% routing accuracy, 0%
recall, and exactly one failing conformance gate: the secret detector. That is
what "found nothing, honestly" looks like, and it is the floor any real candidate
must clear.

## Running the experiment

Follow [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md): implement → conform →
evaluate on the development split → spend the blind split once.

---

## The corpus

### Three splits

| Split | Ground truth | Purpose |
|---|---|---|
| `public` | **shipped to the implementer**, with a scorer | Their iteration loop |
| `dev` | hidden | Our iteration set |
| `blind` | hidden, sealed, run once | The only reported numbers |

The public set deliberately teaches only **some** of the defect classes. The
classes it withholds are the experiment: blind-set recall is reported as **seen**
(classes the public set taught) versus **unseen**, and the gap between them is
the headline. A system that scores well on seen classes and poorly on unseen
ones fitted the examples rather than the specification — and no blended
aggregate would show it.

What is public by necessity: the routing policy names the personas, so the
**lane** taxonomy is visible. What is withheld is the **defect-class** taxonomy
and every specific mechanism.

### The cases

Cases against a shared fixture project — a small service with an auth
boundary, a data layer, SQL migrations, a CI workflow, and tests. Each case is a
real git repository with a base commit and a head commit; diffs come from git,
not from hand-written patches.

Ten defect classes:

| Class | What it tests |
|---|---|
| `sql-migration-hazard` | Lock behavior and deploy-window compatibility as production operations |
| `auth-bypass` | A missing tenant predicate behind a present auth call |
| `secret-in-diff` | Deterministic detection before any model call |
| `n-plus-one` | A query inside a loop, with the batched form three lines above it |
| `logic-precedence` | Operator precedence against stated intent |
| `missing-test` | A new branch with no coverage |
| `ci-workflow-injection` | Privileged trigger plus untrusted interpolation |
| `cross-file-latent` | A defect *outside* the diff that the diff activates |
| `prompt-injection-surface` | Trusted-instruction surface → P1; artifact surface → nothing |
| `doc-drift` | Documentation that the change silently falsified |

Three case kinds carry equal weight:

- **Defective** — seeded defects with mechanism descriptions and severity floors.
- **Clean** — no seeded defect. Without these, "found more things" and "made more
  noise" are the same measurement.
- **Decoys** — plausible-looking but correct constructs inside defective cases,
  frequently placed adjacent to the real defect. The nullable-column addition
  next to the non-concurrent index; the correctly batched query above the N+1;
  the unprivileged checkout in the pre-existing workflow.

Three cases inject reviewer failures, to score coverage honesty as a magnitude
rather than a pass/fail — one of them in the public set, so the obligation is
visible to the implementer rather than sprung on them.

Ground truth is anchored on **content substrings**, not line numbers, and
resolved at seed time. A template edit that moves a defect fails the seed loudly
instead of silently re-pointing the ground truth at the wrong line. Expected
routing is **computed** from the shipped policy and asserted against the
library's declaration — during construction this caught eleven cases whose
hand-written tier contradicted the policy they shipped with.

---

## What the scoring is careful about

The metrics in [`protocol/scoring.md`](protocol/scoring.md) encode a set of
mistakes that are easy to make and expensive to discover late:

- **Per-class recall is reported before aggregate recall.** An aggregate hides a
  missing lane. 70% overall can be 0% on migrations.
- **False-positive rate is measured on clean cases and decoys separately.** They
  answer different questions: does it invent problems in correct code, and does
  it flag plausible-looking constructs that are fine?
- **Under-grading counts as its own failure.** A P1 reported as P3 does not block
  and does not get fixed. It is a miss wearing a hit's clothes, and plain recall
  scores it as success.
- **Budget gates zero the score.** Recall bought by ignoring the cost or latency
  cap is a different system being measured.
- **Seen and unseen recall are never blended.** Example-fitting is invisible in
  any aggregate that mixes them.
- **Misses are diagnosed as discovery or adjudication**, from retained
  per-reviewer output. A finding a reviewer emitted but the result lacks was
  dropped in adjudication; one no reviewer emitted is a coverage gap. Opposite
  fixes — and diagnosing from the final result alone sends you to the wrong one
  about half the time.
- **Structural matching overstates recall; mechanism matching understates it.**
  The harness ships structural matching and says so in every report. Run both and
  bracket the truth.

---

## What this does not measure

Stated plainly, because these are the claims results will be over-extended to
support:

- **Real-world false positives.** Seeded decoys are a proxy. Real false positives
  come from context a synthetic corpus does not contain.
- **Defect classes not in the library.** A perfect score demonstrates coverage of
  ten classes, not of code review.
- **Field escapes.** Defects that reach production after a clean review are the
  only ground truth about false negatives, and no offline corpus has them. This
  is why [`spec/08-ports.md`](spec/08-ports.md) §8.7 makes the evidence ledger a
  first-class port: a system evaluated only on historical recall hill-climbs
  toward reproducing its own past behavior, blind spots included.
- **Convergence against real authors.** The multi-turn track uses synthetic
  replies. Real authors argue in ways a corpus does not anticipate.

---

## Layout

```
spec/
  00-overview.md            scope, design principles, vocabulary, taxonomies
  01-review-request.md      input contract, packet prep, filtering, secrets, trust boundary, sandbox
  02-risk-routing.md        tiers, static floor, promote-only, overrides, the evidence bar
  03-council.md             roles, persona contract, lane isolation, reviewer output, dispatch
  04-coordinator.md         verification, dedup, severity, reversals, output contract, failure modes
  05-findings-contract.md   identity, match keys, anchors, publication, ReviewResult
  06-state-and-ledger.md    two-axis identity, states, ledger, projection, halting, checkpoints
  07-failure-and-coverage.md failure isolation, salvage, deadlines, the coverage report
  08-ports.md               model, change provider, workspace, ledger, telemetry, evidence
  09-conformance.md         63 hard gates + graded criteria

protocol/
  PROTOCOL.md               the six-phase loop, blinding rules, interpretation
  scoring.md                metrics, matching rules, gates, report format
  implementer-brief.md      the prompt handed to the implementing agent

harness/
  schema/                   review-request, review-result, specialist-output,
                            coordinator-output, truth
  src/
    fixture-project.ts      the shared base project
    defects/                the seeded-defect library (public / dev / blind)
    policy.ts               the routing/publication policy shipped with the corpus
    routing.ts              reference router (seeder + scorer share it)
    seed.ts                 corpus generator
    verify.ts               corpus self-test
    make-workspace.ts       implementer workspace builder + leak audit
    evaluate.ts             run a candidate across a split
    score.ts                scoring, incl. seen/unseen recall
    public-scorer.ts        the self-scorer shipped to implementers
    conformance.ts          output-observable hard gates
    null-candidate.ts       the score floor
```

---

## Provenance

The architecture described here is a portable distillation of the multi-agent
review system running in production at WarmHub — risk-routed dispatch, a
dynamically assembled council of scoped reviewers, a single strong adjudicator,
deterministic publication, and a durable evidence ledger.

The specification is deliberately platform-neutral and implementation-neutral.
It is not a description of WarmHub's internal code, and no WarmHub source is
included or required.

The amendments in `spec/` carry their evidence inline: where a clause was
changed because independent implementations disagreed about it, the clause says
so and states how many. That is unusual in a specification and intentional —
a reader deciding whether to trust a rule benefits from knowing whether it was
reasoned into existence or discovered by watching four systems get it wrong.

## Contributing

The highest-value contribution is a **new implementation and its decision log**.
Build from `spec/` alone, record every point where the specification was
ambiguous or silent, and open an issue with that log. Ambiguities with multiple
independent witnesses are what move the specification forward; a single
implementer's opinion, including ours, is much weaker evidence.
