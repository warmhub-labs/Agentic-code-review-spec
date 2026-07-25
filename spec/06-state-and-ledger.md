# Part 6 — State Machine and Ledger

**Multi-turn review: convergence, memory, and knowing when to stop**

> Required for a production deployment. A single-turn implementation that
> satisfies Parts 1–5, 7 and 9 is conforming for the single-turn evaluation
> track; Part 6 is exercised by the protocol's optional multi-turn track.

---

## 6.1 The problem this solves

A stateless reviewer, re-run after every fix, has **no defined fixed point**. On
prose, every word is mutable surface and there is always another precision nit.
On code, every fix introduces new code with new latent issues. Add manual
re-runs against unchanged revisions and the review count decouples from the
change entirely.

The failure is structural, not size-driven. In the reference corpus, churn per
line of code was *inversely* correlated with change size: the worst offender was
a 29-line documentation change that accumulated eight reviews. A 21,000-line
change had sixteen reviews of which only two were engaged — the other thirteen
were re-runs against revisions that had not changed.

Four divergence classes, with their fixes:

| Class | Mechanism | Fix |
|---|---|---|
| Real-bug cascade | Each fix touches new code with latent issues | Coordinator + cross-turn memory |
| Nit cascade | Endless P3 precision findings | Severity floor on halting; P3 capped after turn 1 |
| False-positive cascade | A rule is progressively narrowed; the reviewer keeps finding edge cases | Meta-check: narrowed N times → ask whether the check is load-bearing |
| Reversal cascade | Findings contradict prior-turn positions | Explicit reversal contract; cross-turn self-consistency |

The state machine and the ledger are the machinery that makes those fixes
implementable.

---

## 6.2 Two-axis identity

A review's result depends on two independent things: **the code being reviewed**
and **the human interaction state since the last review**. Conflating them
causes the two worst failures at once — re-reviewing unchanged code, and
ignoring an author who replied.

**Axis 1 — the content key.** A hash over: the packet digest (Part 1 §1.9), the
base revision, the merge base, the routing policy, the dispatch policy after
overrides, the eligible persona set with content hashes, the base-revision
instruction tree, the deterministic audit output, and the coordinator output
schema.

It MUST NOT include the head revision identifier, run identifier, trigger, actor,
or timestamp. A squash or rebase producing an identical tree therefore produces
an identical key — correctly recognized as nothing new to review.

**Axis 2 — the interaction watermark.** A hash over the identifiers of the
latest relevant thread activity, comment, and review event.

**Run identity** — head revision, run id, trigger, actor — is recorded for audit
and is **not** part of any skip decision.

---

## 6.3 States

| State | Council | Coordinator depth | Publication | Counts as a turn? |
|---|---|---|---|---|
| `INITIAL` | Tier council, parallel | high–xhigh | All severities, P3 capped | Yes |
| `FIX_VERIFICATION` | None | high | P0/P1 always; P2 when introduced by the fix, a regression of a prior finding, or tier-required | Yes |
| `AUTHOR_RESPONSE_REVIEW` | None | low–medium | **No new findings.** Thread actions, status updates, explicit retractions, clarifications | Yes |
| `CONVERGENCE` | None | medium–high | P0/P1 only | Yes |
| `FINAL_FRESH` | Tier's `finalFreshCouncil` | xhigh | P0/P1 always; P2 by tier | Yes |
| `SKIP_SAME_CONTEXT` | — | — | Nothing published | **No** |
| `SKIP_TIER_POLICY` | — | — | Nothing published | No |
| `NEEDS_HUMAN_ESCALATION` | — | — | Summary only; explicit list of still-blocking findings; **never auto-approve** | **No** |

### Selection

```
selectTurnState(priorLedger, contentKey, interactionKey, changedFiles,
                openBlockers, round, policy, tier, event):

  if no priorLedger                      -> INITIAL

  sameCode        = contentKey     == priorLedger.contentKey
  sameInteraction = interactionKey == priorLedger.interactionKey

  if sameCode and sameInteraction        -> SKIP_SAME_CONTEXT
  if sameCode and not sameInteraction    -> AUTHOR_RESPONSE_REVIEW

  # code changed
  if tierPolicySkips(tier, policy, changedFiles) -> SKIP_TIER_POLICY
  if shouldEscalate(...)                 -> NEEDS_HUMAN_ESCALATION
  if shouldRunFinalFreshBeforeHalt(...)  -> FINAL_FRESH
  if shouldConverge(...)                 -> CONVERGENCE
  otherwise                              -> FIX_VERIFICATION
```

The `sameCode && !sameInteraction` branch is the one people leave out, and it is
the one that matters most in practice. Without it you must choose between
re-running a full review because someone left a comment, or ignoring the comment
entirely. The cheap author-response state is the third option.

### After `FINAL_FRESH`

- Published blocking findings → the next code change returns to
  `FIX_VERIFICATION`.
- Clean → halt, and record that the fresh read is complete **for this content
  key**. The flag resets when the content key changes.

---

## 6.4 The ledger

Per-change persistent state. Its shape:

**Metadata** — schema version, package version, policy hash, previous ledger
digest (for the stale-run guard), current digest, creating run id, timestamp.

**Change identity** — change id, base ref, base revision, merge base.

**Two-axis identity state** — the content key and its hash, the interaction
watermark and its hash.

**Run identity** — current head, every head revision ever reviewed at this
content (aliases), current run id.

**Tier and state** — static tier, effective tier after promotion, round counter,
halted flag, fresh-read-complete flag.

**In-progress lock** — a flag and timestamp guarding the expensive fresh-read
state against concurrent runs. A run seeing a lock younger than the configured
window defers; a stale lock is presumed crashed and superseded.

**Findings** — the full `Finding` array with status, history, and thread ids.

**Turn history** — one record per engaged turn: turn number, state, run id, head
and base revisions, both key hashes, council invoked, coordinator model,
candidates in, published out, suppressed out, reversals detected, whether the
content key reverted to a previously-reviewed one, halted flag, timestamp.

**Run history** — one record per invocation, including skips, escalations, and
deferrals, each with an outcome.

### Turns versus runs

| | Increments the round? | Counts against the turn budget? |
|---|---|---|
| **Run** — any invocation, including skips and escalations | No | No |
| **Turn** — an engaged invocation that ran a coordinator | Yes | Yes |

The turn budget protects the *engaged iteration count*, not the wall-clock
invocation count. Manual re-review storms should be nearly invisible: they
append run records and nothing else.

### Stale-run guard

Before publishing, re-read the ledger and compare its digest against the digest
recorded at the start of this run. If they differ, another run has won the race:
abort publication, record `stale_run_aborted`, exit cleanly.

### Ledger unavailable

If the prior ledger cannot be retrieved, attempt best-effort reconstruction from
whatever durable marker records the digest. If reconstruction fails, start a
conservative fresh ledger with the fresh-read flag unset, **do not auto-approve**,
behave as `INITIAL`, and record the warning.

---

## 6.5 The ledger projection

The coordinator receives a bounded projection, never the raw ledger.

```jsonc
{
  "open_findings":            [ /* status ∈ open, unresolved, disputed — verbatim */ ],
  "recently_fixed_findings":  [ /* fixed within the last 2 rounds — verbatim */ ],
  "active_dispute_threads":   [ /* ≥1 round of unresolved disagreement */ ],
  "reversal_history":         [ /* every reversal in this change's lifetime */ ],

  "total_turns": 0,
  "total_published": 0,
  "prior_states_visited": ["INITIAL", "FIX_VERIFICATION"],

  "earlier_findings_summary": {
    "fixed_count_by_category": { "correctness": 3 },
    "waived_count": 0,
    "superseded_count": 1
  },

  "current_run": { "state": "FIX_VERIFICATION", "round": 4, "is_final_fresh": false }
}
```

**Token cap**, per tier (reference: 8K critical/high, 6K medium, 4K low). When
the projection exceeds the cap, drop in order: oldest recently-fixed findings
first, then collapse the visited-states list to a count. Open findings, active
disputes, and the full reversal history are **never** dropped — they are the
state the coordinator cannot function without.

Reversal history is retained in full because it is small and because it is the
only defense against a reversal cascade: the coordinator must be able to see
that it has already flip-flopped on this code.

---

## 6.6 Halting

```
shouldHalt(ledger, proposedTurn, tier, state, policy):
     no open finding whose severity ∈ policy.halt.zeroOpen
 AND no NEW finding this turn whose severity ∈ policy.halt.zeroNewThisTurn
 AND (fresh read complete for this content key, OR not required by tier)
```

`zeroNewThisTurn` requires the current turn's proposed result, not just the
ledger — the turn has not been merged yet when the decision is made.

**Pre-halt fresh read.** When a tier lists `FINAL_FRESH` as mandatory and the
turn is otherwise halt-eligible, run the fresh read *before* halting rather than
halting. This is the last chance for an un-anchored reviewer to catch what the
dialogue lost.

**Escalation.** Transition to `NEEDS_HUMAN_ESCALATION` when the turn budget is
exhausted with open blocking findings, when a dispute loop occurs (three or more
consecutive turns of author disagreement with the coordinator holding), or when
reversals repeat on the same finding.

Escalation is recorded in run history only. It does not advance the round or
consume the turn budget: it is a terminal report, not another iteration.

**The false-positive meta-check.** Track how many times a single finding has
been narrowed across turns. Past a threshold (reference: 3), the coordinator is
prompted to ask a different question: *is this check load-bearing at all?* This
is the specific fix for the false-positive cascade, where a rule is progressively
narrowed and the reviewer keeps finding edge cases at its new boundary. The
correct outcome is often to retract the whole line of findings rather than narrow
it once more.

---

## 6.7 Idempotency and concurrency

- Ledger merge MUST be **idempotent**: merging the same turn result twice
  produces the same ledger. Property-test this.
- Concurrent runs on the same change SHOULD be serialized by a
  cancel-in-progress concurrency group on code-change events, with a **separate**
  group for manual triggers so manual re-reviews queue rather than cancel each
  other.
- The stale-run guard is the second safety net when cancellation does not
  propagate cleanly.
- Expensive states take the in-progress lock before invoking models.

---

## 6.8 Phase separation and checkpoints

Model work is expensive; publication is failure-prone. Separate them so a
publication failure never invalidates model work.

```
A  Read inputs, classify, compute keys, run scanners
B  Build the ledger projection
C  Invoke council + coordinator
   └─ CHECKPOINT: cache the structured coordinator output, keyed on
      (content key hash, role, model)
D  Deterministic post-processing
   └─ CHECKPOINT: cache the resolved publish set
E  External operations — publish, thread mutations, persist ledger
```

A failure in E does not invalidate C or D. On retry, if the content key is still
valid, replay the cached publish set and go straight to E. **No model
re-invocation.**

Before entering a model-invoking state, check the external API's remaining rate
budget against a configured reserve. If short, record a deferral and exit
cleanly — the next trigger resumes. A deferral is non-terminal: it does not
consume a turn and it does not escalate.

**Thread mutations are best-effort.** Wrap each individually. On "already
resolved", "outdated", or not-found: log the drift, clear the recorded thread
id so the next turn re-fetches, continue. Thread drift is cosmetic; the ledger
is the system of record and the next turn reconciles.
