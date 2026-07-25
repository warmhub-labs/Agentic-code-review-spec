# Part 5 — The Output Contract

**Deterministic post-processing, and the `ReviewResult`**

---

## 5.1 What post-processing owns

Everything between the coordinator's structured output and the final result is
deterministic. No model calls. This is the layer that can be tested exhaustively,
in milliseconds, with no provider dependency — and it is where every decision
that must be reproducible lives.

In order:

1. Resolve `candidate_ref` and `prior_finding_id` into stable finding identities.
2. Compute cross-turn match keys.
3. Validate every evidence anchor against the diff and assign an anchor status.
4. Validate severity and category against the closed taxonomies.
5. Apply publication policy for the current turn state and tier.
6. Merge dispositions into the ledger.
7. Compute the overall rating, blocking status, and halt decision.
8. Assemble the coverage report.
9. Render the result.

---

## 5.2 Finding identity

A finding's `id` is assigned **at first publication** and is **immutable**.

`id` MUST NOT depend on title wording, evidence hunk content, severity, or any
field the coordinator may rephrase between turns. An opaque monotonic or
content-independent identifier is correct; a hash of the finding's prose is not.

The coordinator never sees `id`. It sees `prior_finding_id` values in the
projection and references them.

Coordinator output that proposes a different `id` for an existing finding, or
that emits an `id` at all, is **rejected**.

---

## 5.3 Match keys

Four deterministic aids, computed by post-processing, used to match a candidate
against a prior finding when the coordinator did not supply a
`prior_finding_id`:

| Key | Composed from |
|---|---|
| `exact_content_key` | category + path + normalized title + evidence |
| `location_key` | category + path + enclosing symbol |
| `evidence_key` | code-context hash, or a hash of the diff hunk |
| `title_key` | normalized title / root-cause phrase |

Ordered from most to least specific. Match keys are **aids**, never identity.

---

## 5.4 Anchor validation

Every anchor is validated against the current diff and assigned a status. The
status governs how the finding may be published.

| Status | Condition | Publication |
|---|---|---|
| `current_diff` | Path and line fall inside a diff hunk | Inline |
| `file_only` | The path **exists in the repository** and the cited line is not in a hunk. The file need NOT be touched by the change | Summary body if severity ∈ {P0, P1, P2} **and** `caused_by_change` is true; otherwise suppress |
| `stale` | A **previously published** finding whose file has since left the diff | Suppress for new findings. Status updates (`fixed`, `stale`) are permitted |
| `unanchorable` | The path does not exist | Suppress and log as a coordinator error |

**`file_only` covers untouched files, and `stale` is a cross-turn concept.** An
earlier version of this table defined `file_only` as "path touched by the
change" and `stale` as "the file is no longer in the diff" — which made the
canonical cross-file defect, a finding on an untouched caller, `stale` and
therefore suppressed. The table forbade exactly what the paragraph below
defends. An implementer found the contradiction; a second implementation
silently resolved it the other way, so the two would have disagreed on the most
valuable class of finding the system produces. `stale` now means only what it
was always for: a finding published on an earlier turn whose file has left the
diff since (Part 6).

**`file_only` is not blanket-suppressed, and that is deliberate.** The most
valuable findings a council produces are frequently the ones that live *outside*
the diff: a change that is correct in isolation but breaks an invariant an
untouched caller relies on. Suppressing everything outside the hunk throws those
away. The affirmative-causation requirement is what keeps the category honest —
the coordinator must claim the change caused it, not merely that it is nearby.

That claim is a **schema field**, `caused_by_change`, not a convention over
prose. The specification previously required the coordinator to "affirmatively
state" causation while giving it a closed schema with nowhere to state it. Three
independent implementations each invented an incompatible marker inside
`details` — a prefix, a token, a sentence pattern. Three implementations, three
conventions, no interoperability. An obligation that the schema cannot express
is an obligation the schema should carry.

**`unanchorable` is a coordinator failure, not a finding property.** Count them.
A rising unanchorable rate means the coordinator is hallucinating paths, and it
is one of the earliest detectable signs of a degraded prompt or model.

Structural anchor rules (rejected at validation):

- `start_line` set without `start_side`.
- `start_line > line`.
- Non-positive or non-integer line numbers.
- `side` values outside `LEFT` / `RIGHT` / null.

---

## 5.5 Cross-turn matching

Deterministic algorithm, in order:

1. If the coordinator supplied a `prior_finding_id` — in `ledger_updates`, or on
   a candidate — resolve it directly. If found, this is a continuation. Record
   the turn in the finding's history.
2. Otherwise compute the candidate's match keys and try, in order:
   `exact_content_key`; then `location_key` with compatible category and
   severity class; then `evidence_key` with compatible category; then
   `title_key` with the same path and category.
3. If exactly one prior finding matches at any level → continuation. **Record
   which aid matched**, for audit.
4. If different aids match *different* prior findings → defer to the
   coordinator's explicit supersession declaration. If there is none, record an
   unresolved match conflict and treat the candidate as new, with a warning.
5. If nothing matches → a new finding. Assign a fresh `id` at first publication.

---

## 5.6 Publication policy

The turn state and tier jointly determine which severities may publish.

```
canPublish(finding, tier, state, policy) =
      finding.severity ∈ policy[tier].publication[state].publish
  AND anchorStatusPermits(finding.anchor_status, finding.severity)
  AND NOT explicitlySuppressed(finding)
  AND withinP3Cap(finding, policy[tier].publication[state].p3Cap)
```

**The P3 cap.** P3 findings are capped on the first turn (reference values: 5 to
20, by tier) and hard-capped to zero on every subsequent turn.

This is the specific fix for one of the four divergence classes. On prose in
particular, every word is mutable surface and a reviewer can always find another
precision nit; without a severity floor on halting, the supply is infinite. P3
findings are also *never* blocking, so capping them costs nothing real.

**Suppression is recorded, not discarded.** A suppressed finding still enters
the ledger with its suppression reason. This preserves the signal for later
analysis and means a policy change can re-surface it. Suppression is a
publication decision, not a deletion.

**Operational caps.** Publication surfaces have limits. Declare and enforce
them:

- maximum inline comments per review (reference: 30)
- maximum summary findings (reference: 50)
- maximum body bytes (reference: 60,000)

Overflow policy: publish the highest-severity findings inline first; demote the
remainder to the summary; if the summary exceeds the body limit, publish the
top N and reference the full ledger artifact. **Overflow MUST be stated in the
result.** Silent truncation reads as a complete review.

---

## 5.7 Blocking and rating

**Blocking** is computed, never stored:

```
isBlocking(finding, tier, state, policy) =
      finding.status ∈ {open, unresolved, disputed}
  AND finding.severity ∈ policy[tier].halt.zeroOpen
  AND NOT validlyWaived(finding, policy.waiverPolicy)
  AND NOT suppressed(finding)
```

Computing it lazily avoids stale values when policy changes between turns.

**Invariants** — all MUST hold, and all are conformance-gated:

- P3 never blocks.
- Suppressed findings never block.
- A waived finding is non-blocking only if the waiving actor is authorized for
  that severity under the waiver policy.
- A disputed finding blocks only if its severity is in the tier's blocking set
  **and** the coordinator's most recent verdict still holds it.
- A reversed finding requires an explicit reversal record. Silent reversals are
  rejected.
- A superseded finding must point at its replacement.
- A finding marked fixed must carry verification evidence or a deterministic
  reason.
- A stale anchor never publishes inline; it may update a prior finding's status.
- `id` is immutable once assigned.
- The turn counter never decreases; skips and escalations never advance it.

**Overall rating**, computed from the published set:

| Rating | Condition |
|---|---|
| `BLOCKING` | Any published blocking finding |
| `MAJOR_CONCERNS` | Any published P1 that is not blocking under this tier |
| `MINOR_CONCERNS` | Published findings, none above P2 |
| `CLEAN` | No published findings |

A `CLEAN` rating on a turn with reviewer failures MUST be reported as
`CLEAN (partial)` with the coverage report attached. See Part 7.

---

## 5.8 The `ReviewResult` contract

The system's output. Schema: `harness/schema/review-result.schema.json`.

```jsonc
{
  "schema_version": "1.0.0",
  "run_id": "string",
  "change_id": "string",
  "head_sha": "string",

  "outcome": "engaged | skipped | escalated | failed | deferred",
  "turn_state": "INITIAL | FIX_VERIFICATION | AUTHOR_RESPONSE_REVIEW | CONVERGENCE | FINAL_FRESH | SKIP_SAME_CONTEXT | SKIP_TIER_POLICY | NEEDS_HUMAN_ESCALATION",

  "routing": {
    "tier": "low | medium | high | critical",
    "static_floor": "low | medium | high | critical",
    "matched_rules": ["string"],
    "overrides_fired": ["string"],
    "council_declared": ["persona-id"],
    "packet_digest": "string"
  },

  "coverage": {
    "declared": ["persona-id"],
    "returned": ["persona-id"],
    "failed": [ { "persona_id": "string", "reason": "string" } ],
    "complete": true,
    "coordinator_ran": true,
    "coordinator_source": "synthesis | deadline_fallback",
    "deadline_exceeded": false,
    "publication_truncated": false
  },

  "overall_rating": "CLEAN | MINOR_CONCERNS | MAJOR_CONCERNS | BLOCKING",
  "blocking": false,
  "halt": { "should_halt": false, "reason": "string | null" },

  "findings": [
    {
      "id": "string",
      "title": "string",
      "severity": "P0 | P1 | P2 | P3",
      "category": "<one of the ten>",
      "confidence": "low | medium | high",
      "status": "open | unresolved | fixed | disputed | waived | stale | superseded | reversed",
      "details": "string",
      "evidence": [
        {
          "path": "string",
          "line": "integer | null",
          "side": "LEFT | RIGHT | null",
          "start_line": "integer | null",
          "start_side": "LEFT | RIGHT | null",
          "symbol": "string | null",
          "anchor_status": "current_diff | file_only | stale | unanchorable"
        }
      ],
      "published": true,
      "publication_surface": "inline | summary | suppressed",
      "suppression_reason": "string | null",
      "origin": "council | coordinator | deterministic_scanner | audit_row",
      "attributed_personas": ["persona-id"],
      "supersedes_id": "string | null",
      "superseded_by_id": "string | null",
      "first_seen_turn": 1,
      "first_published_turn": 1
    }
  ],

  "suppressed_count": 0,
  "audit_rows_dispositioned": 0,
  "audit_rows_undischarged": 0,

  "reviewer_summaries": [
    { "persona_id": "string", "summary": "string", "candidate_count": 0, "files_reviewed": ["string"] }
  ],

  "telemetry": {
    "duration_ms": 0,
    "cost_usd": 0.0,
    "input_tokens": 0,
    "output_tokens": 0,
    "per_persona": [
      { "persona_id": "string", "duration_ms": 0, "cost_usd": 0.0, "status": "completed | failed | timeout" }
    ]
  },

  "errors": [ { "stage": "string", "message": "string", "fatal": false } ]
}
```

### Field obligations

- `coverage.complete` is `true` **only** when `failed` is empty, the deadline
  was not exceeded, and `coordinator_source` is `synthesis`. It is a computed
  field and it is a hard conformance gate.
- `attributed_personas` lists every reviewer that proposed a candidate which
  merged into this finding. Attribution is **descriptive, not predictive** — see
  §5.9.
- `origin` distinguishes model-proposed findings from deterministic ones.
  Scanner and audit-row findings are not council performance.
- `findings` includes suppressed findings, with `published: false` and a reason.
  Consumers filter; the system does not hide.
- `telemetry.per_persona` is required for every declared reviewer, including
  failures.

### The companion artifact

Alongside `ReviewResult`, the system MUST retain per-reviewer raw output:

```jsonc
{
  "run_id": "string",
  "packet_digest": "string",
  "personas": [
    {
      "persona_id": "string",
      "status": "completed | failed | timeout | salvaged",
      "raw_output": { /* the reviewer's JSON, verbatim */ },
      "error": "string | null",
      "model": "string",
      "thinking_level": "string"
    }
  ],
  "coordinator_raw_output": { /* verbatim */ }
}
```

Retention is not optional. Part 3 §3.7 explains why: without it, a
composition regression cannot be localized to discovery or adjudication, and
those have opposite fixes.

---

## 5.9 What attribution does and does not mean

`attributed_personas` records which reviewer proposed a candidate that became a
finding **in this run, with this council**. That is all.

It does **not** mean the reviewer would find that defect alone. Credit is
conditional on the council's composition: a reviewer may receive credit simply
by emitting first among several that would have found it, and a reviewer with a
perfect historical record on a path may contribute nothing when routed alone,
because the fresh defects on that path belong to a category it was never scoped
to.

Treat attribution as a **diagnostic** for localizing regressions, never as a
routing signal. Deriving a routing rule from attribution requires ablation
evidence — see Part 2 §2.8.
