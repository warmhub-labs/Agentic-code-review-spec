# Part 7 — Failure Isolation and Coverage Honesty

**The rule that a partial review must never be able to pose as a clean one**

---

## 7.1 Why this gets its own part

Every other property in this specification degrades gracefully. This one does
not.

A review system's output is consumed as an assertion: *"this change was reviewed
and here is what was found."* If a reviewer silently fails and the system reports
no findings, the consumer receives that assertion with none of the review behind
it. The failure is invisible precisely when it matters — the lane that crashed
is as likely as any other to have been the one holding the defect.

Worse, it is self-concealing. A council that reports "no findings" after four of
six reviewers timed out looks exactly like a council that ran completely and
found nothing clean. There is no downstream signal that distinguishes them, and
no amount of later analysis recovers the difference.

So: **a failed dispatch is never conflated with silent acceptance.** This is a
hard conformance gate.

---

## 7.2 What counts as a failure

A dispatched reviewer has **failed** when any of these holds:

| Condition | Notes |
|---|---|
| The process crashed, errored, or was killed | — |
| It timed out against the turn deadline | — |
| Output is not parseable as JSON | After the salvage attempt in §7.4 |
| Output does not validate against the reviewer schema | — |
| `reviewed` is anything other than boolean `true` | Including missing, `false`, or the string `"true"` |
| `summary` is missing or shorter than the minimum | — |
| `audit_rows_reviewed` is missing or not an array | — |
| It returned fewer than all in-scope audit rows in `audit_rows_reviewed` | Incomplete discharge |

Note the last four. They are **contract failures, not empty results**. A
reviewer that returns `{"candidates": []}` and nothing else has not affirmed
that it engaged, so its silence carries no information. Treating it as a clean
lane is exactly the error this part exists to prevent.

**A reviewer that returns `reviewed: true`, a real summary, complete audit-row
discharge, and zero candidates has succeeded.** Empty candidates is a correct,
complete, valuable result.

---

## 7.3 Isolation

- One reviewer's failure MUST NOT abort the council.
- Failures are collected into a failure list; successes proceed to the
  coordinator.
- The coordinator MUST be told which reviewers failed, and MUST NOT compensate
  by inventing findings in the missing lanes.
- The coordinator runs even when *every* reviewer failed — its own verification
  and prior-finding disposition still have value — but the run is reported with
  `coverage.complete: false`.

---

## 7.4 Salvage — bounded, never fabricating

When a reviewer completes but its final message is unparseable, the
implementation MAY attempt one conservative salvage: scan the reviewer's own
session transcript for the last well-formed output envelope and use it.

Rules:

- Salvage only from **that reviewer's own** transcript.
- Salvage only a **complete, schema-valid** envelope. A partial one is not
  salvaged.
- **Never fabricate `reviewed: true`.** If the salvaged envelope does not itself
  assert engagement, the salvage fails and the reviewer is recorded as failed.
- An unreadable or absent transcript salvages nothing.
- Salvaged reviewers MUST be recorded distinctly (`status: salvaged`), never
  silently merged into normal completions.

Salvage recovers real work that a serialization glitch would otherwise discard.
It must never manufacture the assertion of engagement — that assertion is the
whole point.

---

## 7.5 Deadline behavior

On deadline expiry mid-council:

1. Collect completed reviewers.
2. Record the rest as failures with reason `deadline`.
3. Set `coverage.deadline_exceeded: true`.
4. Proceed to the coordinator with what completed, if the remaining budget
   allows.

If the deadline expires before the coordinator produces usable output, the
implementation MAY emit a **deadline fallback** result: a conservative,
deterministically-constructed output derived from the reviewer candidates
without adjudication.

A deadline fallback MUST:

- set `coverage.coordinator_source: "deadline_fallback"`;
- set `coverage.complete: false`;
- **never** report `overall_rating: CLEAN`. Unadjudicated candidates have not
  been verified, and an unverified quiet result is not a clean one;
- be clearly marked in the rendered output.

Rationale: a partial publication is better than nothing, because a
cancelled-at-deadline run that publishes nothing loses genuine work — but only
if the consumer can tell. The moment a fallback can present as a normal clean
review, the fallback is a liability.

---

## 7.6 The coverage report

Every result carries one. It is computed, never asserted.

```jsonc
{
  "declared": ["a", "b", "c"],
  "returned": ["a", "b"],
  "failed": [ { "persona_id": "c", "reason": "timeout after 900s" } ],
  "complete": false,
  "coordinator_ran": true,
  "coordinator_source": "synthesis",
  "deadline_exceeded": true,
  "publication_truncated": false
}
```

**Computation:**

```
complete =  failed.length == 0
        AND declared ⊆ returned
        AND coordinator_ran
        AND coordinator_source == "synthesis"
        AND NOT deadline_exceeded
```

`declared` comes from the dispatch plan — what routing said should run — not
from what was attempted. A reviewer that was never launched because of an
orchestration bug must appear as a coverage shortfall, not vanish from the
denominator.

**Declared-versus-returned mismatch MUST be emitted as its own distinct event**,
separate from the failure list, so that monitoring can alert on coverage
shortfalls independently of individual reviewer errors. These are different
questions: "did reviewer X fail?" and "did the council we planned actually run?"

---

## 7.7 Rendering rules

The rendered output MUST make partial coverage impossible to miss.

- A run with `coverage.complete: false` MUST NOT render as an unqualified clean
  review. Render `CLEAN (partial — N of M reviewers reported)`.
- The failed reviewer list MUST appear in the rendered body, with reasons.
- Reviewer summaries MUST be shown even for reviewers with zero candidates, so
  a reader can see what a quiet lane actually inspected.
- Publication truncation (Part 5 §5.6) MUST be stated: *"showing top 30 of 47
  findings."*
- A deadline fallback MUST be labelled as such.

**No silent caps.** Any place the system bounds its own output — reviewer count,
finding count, body size, file reads, search matches — MUST say so in the
result. Silent truncation reads as completeness, and reads as completeness
exactly when it is least true.

---

## 7.8 Fail-safe posture

When the system cannot complete a review, it says so. It never converts its own
failure into an approval.

| Failure | Response |
|---|---|
| Coordinator produced no usable output | Emit an explicit failure result, shaped exactly as §7.8.1 requires. **No auto-approve. No speculative findings.** |
| Provider unavailable | Failure result. Fall back to another reviewer only in a shadow deployment, never in the enforcing path. |
| External rate budget exhausted | Non-terminal deferral. Does not consume a turn, does not escalate, resumes on the next trigger. |
| Publication failed after retries | Persist the ledger regardless — it is the system of record — record the outcome, emit a deferred-publication signal. Do not auto-approve. |
| Ledger unrecoverable | Conservative fresh start, fresh-read flag unset, no auto-approve, warning recorded. |
| Every reviewer failed | Coordinator still runs on prior state; result is `coverage.complete: false` and cannot render clean. |

### 7.8.1 The coordinator-failure result — exact shape

A coordinator failure is **not** a deadline fallback, and the two must not be
conflated. A fallback has unadjudicated candidates and may publish them under a
banner (§7.5); a coordinator failure has no adjudication at all and publishes
none of them.

When the coordinator produces no usable output after its retry, the result MUST
be exactly:

| Field | Value |
|---|---|
| `outcome` | `failed` |
| `turn_state` | the state that was selected, unchanged |
| `coverage.coordinator_ran` | `false` |
| `coverage.coordinator_source` | `none` |
| `coverage.complete` | `false` |
| `overall_rating` | `MAJOR_CONCERNS` if any deterministic finding exists, else `MINOR_CONCERNS`. **Never `CLEAN`.** |
| `blocking` | `true` if any deterministic P0/P1 exists, else `false` |
| `findings` | Deterministic-origin findings only — `deterministic_scanner` and undischarged `audit_row`. Every council candidate is **suppressed**, with reason `coordinator_failure`. |
| `errors[]` | At least one entry with `fatal: true` naming the coordinator failure |

`CLEAN` is forbidden without qualification. A review in which nothing was
adjudicated has established nothing, and a rating that reads clean would assert
the opposite.

Deterministic findings survive because they never depended on the coordinator:
a detected secret is a fact about the diff, not a verdict. Council candidates do
not survive, because unverified hypotheses are precisely what adjudication
exists to filter.

The enum value `none` exists for this case. Earlier versions offered only
`synthesis` and `deadline_fallback`, so four independent implementations each
improvised a different combination here — and one of them had to route a
coordinator failure through the fallback value, which then collided with the
rule that a fallback must never report `CLEAN`.

---

## 7.9 Required failure telemetry

Per run, the implementation MUST record:

- declared reviewer count, returned count, failed count, salvaged count;
- per-reviewer status, duration, and cost — **including failures**, whose
  duration and cost are real and must not vanish from the accounting;
- coordinator source (`synthesis` or `deadline_fallback`);
- whether the deadline was exceeded, and by how much;
- publication truncation counts;
- undischarged audit-row count.

Failures that cost money and produce nothing are the most important cost line in
the system. A cost model that only counts successful reviewers will
systematically understate the price of an unreliable council, and will make a
flaky configuration look cheaper than a reliable one.
