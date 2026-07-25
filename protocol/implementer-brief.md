# Implementer Brief

**Hand this to the agent building from the specification. It is the whole
prompt.**

---

## Your task

Build a working code review system from the natural-language specification in
`spec/`.

The system takes a `ReviewRequest` — a change to a codebase, plus policy and
context — and returns a `ReviewResult`: structured defect findings with evidence
anchors, plus an honest account of how much review actually ran.

You have the specification and the JSON schemas. You do not have a reference
implementation. Build it.

---

## What you have

```
spec/            Parts 0–9. The complete behavioral specification.
schema/          JSON Schemas for the four wire contracts.
public/          Labeled cases. Each carries a ReviewRequest, the repository,
                 and truth.json — the defects a correct review finds, with
                 mechanisms, severities and locations. Two also carry a fully
                 worked ReviewResult.
score-public.ts  A scorer over the public cases. Your iteration loop.
ENVIRONMENT.md   What is installed on this machine.
```

Read all of `spec/` before writing code. Parts 0, 5, 7 and 9 are the ones people
skim and then get wrong: Part 0 carries the design principles that the
conformance gates encode, Part 5 is the output contract, Part 7 is the honesty
rules, and Part 9 is exactly what you will be graded on.

### The public set, and the blind set behind it

The public cases are yours to use however you like — read the truth files, score
against them, iterate. That is what they are for.

You will be **measured on a blind set you never see**. It is larger, and it
covers defect classes that **do not appear in the public set at all**. This is
deliberate and it is the central measurement: whether you built the system the
specification describes, or a system that finds the specific defects you were
shown.

Two consequences worth taking seriously:

- **Do not tune until `score-public.ts` reads 100%.** A council scoped to the
  public set's defect classes will score well there and badly where it counts.
  The spec's own guidance (Part 0, P4) is the better guide: coverage breadth
  across independent lanes, not depth on the examples in front of you.
- **The routing policy tells you the lane taxonomy** — it names the personas the
  council assembles. Build every lane the policy declares, including lanes no
  public case happens to exercise. A lane with no public example is not a lane
  that does not matter; it is the part of the corpus you cannot see.

---

## What you deliver

An executable satisfying this contract:

```bash
<your-binary> review --request <path/to/review-request.json> \
                     --out <path/to/review-result.json> \
                     --artifacts <dir>
```

- **Exit 0** on a completed review — *including* a review that reports reviewer
  failures. A partial review that honestly reports itself as partial is a
  success, not an error.
- **Non-zero** only when no result could be produced at all.
- `--out` receives a `ReviewResult` validating against
  `schema/review-result.schema.json`.
- `--artifacts` receives per-reviewer raw output and coordinator raw output, per
  `spec/05-findings-contract.md` §5.8. This is required, not optional.

Also deliver:

```bash
<your-binary> conformance --fixtures <dir>
```

running the hard gates from `spec/09-conformance.md` against fake ports.

**Free choices:** language, runtime, model provider, prompt wording, package
layout, whether you use a framework. Nothing in the spec constrains these.

**Not free:** the wire contracts, the hard gates, and the design principles in
Part 0. Those are the specification.

---

## Scope

**Required — the single-turn track.** Parts 1–5, Part 7, and hard gates
C-01 … C-51 plus C-61 … C-63. Ports: `ModelAgent` and `Workspace` real;
everything else may be a no-op fake.

**Optional — the multi-turn track.** Part 6 and gates C-52 … C-60. Attempt it
only after the single-turn track passes conformance cleanly.

---

## Rules

1. **Work only from your workspace.** Everything you are permitted to see is in
   it. Do not go looking for the blind corpus, the real scorer, or a reference
   implementation elsewhere on the machine. If you find something that looks
   like blind-set data inside your workspace, stop and report it — its presence
   is a harness bug that would void the run.
2. **Do not hardcode against the public cases.** They show you the shape of a
   real request, a real result, and a real defect. They are not the test suite.
   Anything that pattern-matches a specific file, line, or phrasing from them
   will score zero on the blind set and reads as overfitting in the report.
3. **Build the fakes first.** The spec is designed so that the entire
   orchestrator, post-processor, and publication policy can be tested with no
   model calls at all. If your conformance suite needs a provider key, you have
   built it wrong, and you will iterate far more slowly than you need to.
4. **Ask the spec, not your instincts.** Where the spec states a MUST, follow it
   even where a different design seems better. Where the spec is genuinely
   silent, decide, and record the decision (§Reporting) — those records are the
   most valuable output of this exercise.
5. **Do not optimize for what you guess the corpus contains.** Build the system
   the spec describes.

---

## Traps

These are the ones implementations get wrong. Each maps to a hard gate.

**Silence is not a clean review.** The single most important property in the
system. A reviewer that crashed, timed out, or returned malformed output is a
*failure*, and it must appear in the coverage report. It is never collapsed into
"found nothing." A run with any failure cannot render as an unqualified clean
review. (C-19 … C-28, and `spec/07-failure-and-coverage.md` in full.)

**`reviewed: true` is a contract, not a formality.** A reviewer returning
`{"candidates": []}` and nothing else has *not* affirmed engagement. That is a
failure. A reviewer returning `reviewed: true`, a real summary, complete
audit-row discharge, and zero candidates has succeeded. Empty candidates is a
correct result; missing affirmation is not. (C-07 … C-09.)

**The model never owns identity.** No stable finding id from the model, ever. No
match keys, no anchor status, no publication decision, no rendered body. The
model emits response-local `candidate_ref` values; deterministic code does the
rest. This is what makes your system testable without a provider. (C-05, C-43.)

**Reviewers must not see each other.** No cross-anchoring, no shared context, no
"here is what the security reviewer said." Independent lanes are the entire
reason a council beats one reviewer. Reviewers also do not see the publication
policy — a reviewer that knows P3 will be suppressed will under-report, and the
signal is lost.

**Routing is pure and reproducible.** Same changed files plus same policy yields
a byte-identical dispatch plan. No model involvement. If your routing is not
deterministic you will fail C-10 immediately, and every downstream measurement
becomes unattributable.

**Additive and subtractive overrides are different.** Subtractive (`match:
"every"`) fires only when *every* changed file is in scope — a mixed change
falls back to the base tier. Additive (`match: "any"`) fires when *at least one*
file is in scope, at any tier. Getting these backwards produces either a
council that never shrinks or, much worse, one that skips review on a change it
only partly understood. (C-13, C-14.)

**Anchors outside the diff are not automatically suppressed.** `file_only`
findings publish to the summary at P2 and above when the coordinator affirms the
change caused them. The most valuable findings a council produces are frequently
the ones outside the hunk — a change that is correct in isolation but breaks an
invariant an untouched caller relies on. Suppressing them all throws those away.
(C-29.)

**Reviewers must read beyond the diff.** Give them read, search, glob, and list
against a sandboxed workspace, and say plainly in the mandate that the most
common miss is a diff that looks fine in isolation but combines unsafely with an
unopened adjacent file. A council restricted to the diff text cannot find that
class at all.

**Secrets are detected, not masked.** A secret in change-added content produces a
P0 *before any model call*, with location-only evidence. The secret's bytes
appear nowhere — not in the finding, not in logs, not in artifacts — and the
model-bound diff carries a redaction marker in place of the line.
(C-45 … C-47.)

**Injection response depends on the surface.** Instruction-shaped content in an
instruction file the change modifies → P1 finding. The same content in a test
fixture or documentation example → recorded, **no finding**. A repository that
legitimately contains injection fixtures must not fire on every touch.
(C-48, C-49.)

**Breadth, not depth, in the council.** Topic reviewers are category
pattern-matchers and default to low or medium depth. Spend the deep budget on
the coordinator, which has to catch contradictions *across* lanes. When a defect
class is missed, add a lane — do not make an existing reviewer think harder.
Depth does not buy coverage of a category a reviewer was never scoped to.

---

## Suggested order

1. Types and schemas. Wire contracts first.
2. Fake ports. Everything testable with no provider.
3. Routing — pure, fully unit-tested. This is deterministic and you should get it
   to 100% before anything stochastic exists.
4. Packet preparation: filtering, redaction, trust classification.
5. Post-processing: identity, anchors, publication policy, rating. Still no model
   calls.
6. **Run the conformance suite here.** Most gates should already pass against
   fakes.
7. Personas and prompts.
8. Real model adapter and workspace sandbox.
9. Council dispatch, failure isolation, coverage reporting.
10. End-to-end against the worked examples.

Steps 1–6 are the bulk of the system and none of them need a model. If you start
at step 7 you will debug prompts and orchestration simultaneously, and you will
be slower.

---

## Reporting

Deliver alongside the implementation:

**`DECISIONS.md`** — every point where the spec was ambiguous or silent, what
you decided, and why. Cite the spec section. This is the highest-value artifact
you produce: it is how the specification gets fixed.

**`COVERAGE.md`** — which spec parts and hard gates you implemented, which you
skipped, and why.

**`NOTES.md`** — anything that surprised you, cost more than expected, or that
you would design differently. Say so plainly; you are not being graded on
agreeing with the spec.

---

## How you will be evaluated

1. **Conformance** — the hard gates in `spec/09-conformance.md`. Pass/fail. A
   failure here stops the evaluation, because a result that does not mean what
   it says cannot be scored.
2. **Defect finding on the blind set** — measured per defect class, and reported
   split two ways: recall on classes the public set taught you (**seen**), and
   recall on classes it did not (**unseen**). Plus false-positive rate on clean
   cases and decoys, severity calibration, routing accuracy, anchor quality,
   cost, and latency.

The gap between your seen and unseen recall is the headline result. A small gap
means you built to the specification. A large one means you built to the
examples.

Build the system the spec describes.
