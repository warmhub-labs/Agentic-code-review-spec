# Scoring

**Metrics, matching rules, and gates**

---

## 1. Ground truth

Each corpus case carries a `truth.json`:

```jsonc
{
  "case_id": "migration-nonconcurrent-index-001",
  "kind": "defective | clean",
  "expected_tier": "high",
  "expected_overrides": ["migration_safety"],
  "expected_council_includes": ["specialist-drizzle-migration-safety"],

  "defects": [
    {
      "defect_id": "d1",
      "class": "sql-migration-hazard",
      "path": "db/migrations/0042_add_index.sql",
      "line_start": 3,
      "line_end": 3,
      "outside_diff": false,
      "min_severity": "P1",
      "expected_category": ["performance", "correctness"],
      "mechanism": "CREATE INDEX without CONCURRENTLY takes ACCESS EXCLUSIVE on a populated table, blocking writes for the duration of the build.",
      "verification": "mechanical | reasoned",
      "verification_note": "..."
    }
  ],

  "decoys": [
    {
      "decoy_id": "k1",
      "path": "db/migrations/0041_add_column.sql",
      "line_start": 2,
      "line_end": 2,
      "why_not_a_defect": "Nullable column addition with no default is a metadata-only operation on this Postgres version; no table rewrite."
    }
  ]
}
```

`verification: "mechanical"` means Phase 0 self-test proves the defect
mechanically — a failing test, a lint hit, a type error. `"reasoned"` means it
cannot be, and `verification_note` carries the written, reviewed rationale.
Reasoned entries are legitimate — an authorization gap or a lock-contention
hazard has no cheap mechanical oracle — but they are the entries most likely to
be wrong, and they should be a minority of the corpus.

---

## 2. Matching a finding to a defect

A finding **matches** a seeded defect when all hold:

1. **Path** — same file, after normalization.
2. **Line proximity** — the finding's anchor falls within
   `[line_start - TOL, line_end + TOL]`, `TOL = 12` by default. When the defect
   is marked `outside_diff`, a `file_only` anchor on the correct path matches.
3. **Category** — the finding's category is in `expected_category`.
4. **Mechanism** — the finding's `details` describes the same failure mechanism.

Matching is **greedy and one-to-one**: each defect is consumed at most once, so
duplicate findings on one defect surface as unmatched rather than double-counting.

### On mechanism matching

Points 1–3 are mechanical. Point 4 is not, and it is where scoring is most
easily fooled in either direction.

Default: mechanism matching is **on**, evaluated by an LLM judge with a strict
rubric, and every judgment is recorded with its rationale. A `--no-mechanism`
flag disables it and scores on 1–3 alone.

Run both and report both. They bracket the truth:

- Structural-only **overstates** recall. A finding that happens to land on the
  right line for an unrelated reason scores as a hit.
- Mechanism-matched **understates** it, by the judge's error rate.

If the two diverge by more than a few points on a candidate, the divergence
itself is the finding — investigate before believing either number. And treat the
judge as a measured component: a recall figure is sensitive to where its
threshold sits, so record judge model and rubric version in the report.

---

## 3. Axes

### 3.1 Per-class recall — report first

```
recall(class) = matched defects of that class / seeded defects of that class
```

Reported per class, always, before the aggregate. An aggregate hides a missing
lane: a candidate at 70% overall may be at 0% on migrations, and the aggregate
will not say so.

### 3.2 Seen versus unseen recall — the headline

Every defect class is either **seen** (the labeled public set teaches it) or
**unseen** (it appears only in hidden splits). Both are measured on the blind
set.

```
recall_seen   = matched defects in seen classes   / seeded defects in seen classes
recall_unseen = matched defects in unseen classes / seeded defects in unseen classes
gap           = recall_seen - recall_unseen
```

`recall_unseen` is the number that matters. Seen recall says the implementer
executed competently against the examples they were handed; unseen recall says
they built the system the specification describes.

A large positive gap means the candidate fitted the examples. It is not
detectable in any blended aggregate, which is precisely why the two are reported
apart. A large *negative* gap is worth investigating too — usually a public case
with an unusually hard instance, not a real result.

Both are computed from the classes present in the corpus, never from a hardcoded
list; the taxonomy is derived so it cannot drift from what was actually seeded.

### 3.2b Aggregate recall

```
recall = total matched defects / total seeded defects
```

Reported separately at `min_severity ≥ P1` and across all severities. The P1
figure is the conventional headline; P2/P3 recall is informative but not what
the system is for. Report it *after* the seen/unseen split, never instead of it.

### 3.3 False-positive rate

Two independent measurements, because they answer different questions:

```
clean_case_fp_rate = clean cases with ≥1 published P2+ finding / clean cases
decoy_hit_rate     = decoys with an UNMATCHED published finding within tolerance
                     / total decoys
```

**"Unmatched" is load-bearing.** Decoy attribution runs only over findings not
already credited to a real defect. Decoys are placed *adjacent* to real defects
on purpose — the nullable-column addition beside the non-concurrent index, the
correctly-batched query above the N+1 — because catching the wrong one of a
neighbouring pair is the error worth measuring.

A naive proximity check over all published findings therefore charges a
candidate for correctly finding the defect next door. On this corpus 6 of 10
decoys sit inside the ±12 tolerance window of a real defect in the same file, so
the naive metric measured adjacency rather than error and inflated the rate by
roughly a third. An implementer caught this from the other side of the blind —
reporting a 100% decoy rate while verifying per-anchor that none of its findings
touched a decoy line.

Clean-case FP asks: *does this system invent problems in correct code?*
Decoy-hit asks: *does it flag plausible-looking constructs that are actually
fine?*

Also report `noise_ratio` = published findings on clean cases per case, so a
system that fires many low-severity findings is distinguishable from one that
fires one confident wrong P1. They are different pathologies.

**Findings at P3 do not count as false positives** on clean cases. P3 never
blocks; a system offering minor observations on correct code is not making an
error, it is being chatty. Report P3 volume separately.

### 3.4 Severity calibration

Over matched defects only:

```
exact       = reported severity == ground-truth min_severity
acceptable  = reported severity >= min_severity     (over-grading)
under       = reported severity <  min_severity     (under-grading)
```

Report all three. Under-grading is the more dangerous error: a P1 reported as P3
does not block and does not get fixed, so it is a miss wearing a hit's clothes.
A recall number that ignores calibration will score it as success.

### 3.5 Routing accuracy

```
tier_accuracy     = cases with correct tier / total cases
override_accuracy = cases where fired overrides == expected / total cases
council_accuracy  = cases where expected_council_includes ⊆ declared / total cases
```

Routing is deterministic. **Anything below 100% is a policy or glob-semantics
bug, and it is fixed in code, never compensated for by tuning a model.**

### 3.6 Coverage honesty

Scored on cases where the harness deliberately injects reviewer failures — a
persona that returns malformed JSON, one that times out, one that returns
`reviewed: false`:

```
honesty = injected-failure cases correctly reporting coverage.complete: false
        / injected-failure cases
```

**This must be 1.0.** It is also a hard gate (C-21). It is scored here so that a
partial failure is visible as a magnitude, not just a pass/fail.

### 3.7 Anchor quality

```
anchor_quality = published findings with anchor_status "current_diff"
               / published findings
```

A correct finding on an unresolvable anchor cannot be acted on. Report
`unanchorable_count` separately — a rising count is the earliest detectable sign
of a degraded coordinator prompt or model.

### 3.8 Cost and latency

Per review: USD, wall-clock milliseconds, input and output tokens.

Report **p50, p95, and max**, never the mean. Latency is what a human or agent
waits on, and the tail is what they remember. A mean hides the tail entirely,
and the tail is usually where the failure modes live.

Include failed reviewers' cost and duration. A council whose expensive reviewer
times out half the time is not cheap, and accounting that counts only successes
will make a flaky configuration look better than a reliable one.

---

## 4. Gates

Hard gates. A candidate failing any scores **zero** — no partial credit:

| Gate | Default |
|---|---|
| Cost per review | ≤ $5.00 |
| Wall clock per review | ≤ 900s |
| Reviewer completion rate | ≥ 0.85 |
| Conformance (Part 9 hard gates) | all pass |
| Coverage honesty | == 1.0 |

Recall bought by ignoring the budget is not recall; it is a different system
being measured. If a candidate is genuinely worth its cost overrun, report that
as a stated trade-off — do not quietly relax the cap and present the number as
comparable.

---

## 5. Composite score

For ranking candidates. Reported **alongside** the axes, never instead of them.

```
if any gate fails: score = 0

score =  3.0 * recall_p1
      +  2.0 * recall_unseen                    # generalization, weighted on its own
      +  1.0 * mean(per_class_recall_p1)        # penalizes a missing lane
      +  2.0 * (1 - clean_case_fp_rate)
      +  1.0 * (1 - decoy_hit_rate)
      +  1.0 * severity_exact_rate
      +  1.0 * anchor_quality
      +  1.0 * routing_accuracy
```

Maximum 12.0.

Three weighting choices are deliberate:

- **Unseen recall carries its own term.** A candidate that scores well only on
  the classes it was shown scores measurably below one that generalizes, even at
  identical aggregate recall.

- **Mean per-class recall sits beside aggregate recall** so that a candidate
  covering nine classes well and one not at all scores below a candidate that
  covers all ten evenly at the same aggregate. Breadth is the property that
  matters; the aggregate alone rewards concentrating on whichever class the
  corpus happens to over-represent.
- **False-positive terms together weigh as much as aggregate recall.** A system
  that finds everything and flags everything has not solved the problem.

Report the vector. The scalar is for sorting.

---

## 6. Variance

Model-driven reviews vary run to run. The default is **single-shot per (case,
candidate)** and variance is part of the score — this matches production, where
each change gets one review.

For a claim that one candidate is genuinely better than another, run `k = 3`
and report the spread. A difference inside the run-to-run spread is not a
difference.

Do not average away a candidate that is bimodal — usually a timeout or
reliability problem masquerading as a quality problem. Report the distribution.

---

## 7. Report format

```jsonc
{
  "run_tag": "string",
  "split": "dev | holdout",
  "candidate_identity": "sha256 of the candidate source tree",
  "corpus_version": "string",
  "corpus_digest": "string",
  "spec_version": "string",
  "k": 1,
  "mechanism_matching": true,
  "judge": { "model": "string", "rubric_version": "string" },

  "gates": { "cost": "pass", "latency": "pass", "completion": "pass",
             "conformance": "pass", "honesty": "pass" },

  "per_class_recall": { "sql-migration-hazard": 1.0, "auth-bypass": 0.67 },
  "recall_p1": 0.0, "recall_all": 0.0,
  "clean_case_fp_rate": 0.0, "decoy_hit_rate": 0.0, "noise_ratio": 0.0,
  "severity": { "exact": 0.0, "over": 0.0, "under": 0.0 },
  "routing": { "tier": 1.0, "override": 1.0, "council": 1.0 },
  "coverage_honesty": 1.0,
  "anchor_quality": 0.0, "unanchorable_count": 0,
  "cost_usd": { "p50": 0.0, "p95": 0.0, "max": 0.0 },
  "latency_ms": { "p50": 0, "p95": 0, "max": 0 },

  "composite": 0.0,

  "misses": [
    { "case_id": "...", "defect_id": "...", "class": "...",
      "present_in_reviewer_output": false,
      "reviewer_candidates_citing_location": [],
      "diagnosis": "discovery | adjudication | unknown" }
  ]
}
```

The `misses` array is the most useful section for iteration, and
`present_in_reviewer_output` is its most useful field. It is computed from the
retained per-reviewer artifacts and it decides which fix to attempt:

- **`true`** — a reviewer found it; adjudication dropped it. Investigate dedup
  and suppression.
- **`false`** — no reviewer found it. Investigate lane coverage and scope
  fences.

Those have opposite fixes, and diagnosing from the final result alone will send
you to the wrong one about half the time.
