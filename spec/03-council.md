# Part 3 — The Council

**Reviewer roles, the persona contract, dispatch, and lane isolation**

---

## 3.1 What a council is

A council is the set of model-driven reviewers dispatched for one turn. It is
**assembled per change**, not fixed: the dispatch plan from Part 2 names which
reviewers run, at what depth, on this change.

Each reviewer is defined by a **persona** — a versioned document combining a
model/runtime configuration with a scoped mandate. Personas are source-controlled
artifacts, reviewed like code, and hashed into the packet digest so that a
persona edit correctly invalidates a skip decision.

---

## 3.2 Role types

| Role | Count/turn | Sees prior findings | Purpose |
|---|---|---|---|
| **Topic reviewer** | 0–8, parallel | No | Deep pattern-matching within one defect category. |
| **Recall-floor reviewer** | 0–1, parallel | No | Unscoped, breadth-first general review. Expected to overlap topic lanes. |
| **Fresh-read reviewer** | 0–1 | No | Merge-time clean read with no dialogue history. Anti-anchoring. |
| **Adversary** | 0–1 | Candidates only | Argues *against* low-confidence candidates. Optional; highest tiers. |
| **Coordinator** | exactly 1 | Yes, via projection | Verify, dedupe, re-rate, dispose. Part 4. |

### Topic reviewers

A topic reviewer owns exactly one lane and is explicitly forbidden from
emitting findings outside it. The mandate must be stated positively (what to
flag, with illustrative categories) **and** negatively (what other lanes own,
listed by name).

Reference lanes: correctness, security, performance/SQL, data integrity,
testing, consistency/maintainability, plus conditionally-added specialists for
migration safety and CI workflows.

The negative list is what makes lanes composable. Without it, every reviewer
drifts toward general review, the coordinator's dedup load explodes, and the
council's diversity collapses into six correlated opinions.

**Escape hatch.** When a topic reviewer notices a serious out-of-lane problem,
it mentions it **once in its summary field, never as a finding**. This preserves
lane discipline while not throwing away the observation.

### The recall-floor reviewer

One deliberately unscoped reviewer covering everything, at meaningful depth. Its
mandate explicitly says it is **expected to overlap** the topic lanes and MUST
NOT stay silent because it assumes a specialist will catch something. Its value
is recall; the coordinator absorbs the duplication.

This lane exists because defects that span categories, or fall between the
scoped lanes, are otherwise systematically invisible.

### The fresh-read reviewer

Invoked only at merge time, in the `FINAL_FRESH` state (Part 6). It sees the
diff and the repository and **nothing else**: no prior findings, no coordinator
verdicts, no ledger, no author replies.

Its purpose is anti-anchoring. A long review dialogue develops a shared frame,
and a shared frame has blind spots. A reviewer that never entered the
conversation does not inherit them. It MUST NOT attempt to deduplicate against
history it cannot see, and MUST NOT adjust severity based on what it imagines
was discussed.

### The adversary

Optional. Receives candidates and argues against the low-confidence ones. Useful
where false-positive cost is high. Reference deployments enable it only at the
top tier.

---

## 3.3 Lane isolation

**Reviewers MUST NOT see each other's output.** Not concurrently, not
sequentially, not summarized.

This is not an implementation convenience — it is the property that makes the
council's diversity real. Reviewers that can see each other converge: the second
reviewer anchors on the first's framing, agrees, and the system mistakes
correlation for corroboration. Independent lanes produce genuinely independent
evidence, which is what the coordinator needs in order to *adjudicate* rather
than tally.

Reviewers other than the coordinator MUST also not see: the ledger or any prior
finding; author replies; the coordinator's prior verdicts; the publication
policy.

The last one is deliberate. A reviewer that knows P3 findings will be suppressed
this turn will under-report, and the system loses the signal in the ledger. The
reviewer's job is discovery. Suppression is a downstream, deterministic
decision.

---

## 3.4 The persona document

A persona is a document with structured front matter and a prose mandate.

```yaml
---
name: specialist-security
description: >
  Topic-focused reviewer for security defects only. Flags authentication,
  authorization, secrets, injection, trust-boundary, and data-exposure
  issues introduced by the change. Part of a parallel council; will NOT
  flag findings outside the security topic.
tools: read, grep, glob, ls
provider: <provider-id>
model: <model-id>
thinkingLevel: medium        # off | minimal | low | medium | high | xhigh
---

# <Role> persona
...prose mandate...
```

**Required front matter:** `name`, `description`. Everything else is optional
and passes through unchanged, so the format is forward-extensible.

**Front matter is configuration; the body is the mandate.** Model, provider,
depth, and tool allowlist live in front matter so routing can override them
per tier without editing prose.

The prose mandate MUST contain, in this order:

1. **Identity and lane** — who you are, what your peers cover, that your only
   job is X.
2. **What to flag** — illustrative categories, explicitly non-exhaustive.
3. **What NOT to flag** — the other lanes, named. Plus the universal
   exclusions: pure formatting a linter handles, naming bikeshedding without a
   concrete confusion scenario, hypotheticals not visible in the change or its
   surrounding context, and "this could be more elegant." Concrete defect or
   skip.
4. **Evidence gate** — see §3.5.
5. **Severity rubric** — what P0/P1/P2/P3 mean *in this lane*, with worked
   examples. Generic severity definitions do not survive contact with a specific
   domain.
6. **Tool guidance** — an explicit instruction to read beyond the diff. State
   plainly that the most common miss is a diff that looks fine in isolation but
   combines unsafely with an unopened adjacent file.
7. **Project-context cross-reference** — how to find and read the nearest
   instruction file for each changed path, and the standing reference documents
   for this lane. Include the downgrade rule: *if an in-tree document explicitly
   documents an accepted tradeoff for the surface you are about to flag,
   downgrade or omit — a tradeoff with in-tree acceptance is a known posture,
   not a new finding.*
8. **Trust posture** — the untrusted-input rules from Part 1 §1.6, restated.
9. **Inputs you receive** — the packet sections this role gets.
10. **Output schema** — §3.6, verbatim, with constraints.

**Depth defaults.** Topic reviewers default to `low`–`medium`. The recall-floor,
fresh-read, and migration-safety reviewers run `high` — the last because its
invocations are sparse and its defect classes are subtle. The coordinator runs
`high`–`xhigh`. See Part 0, P4.

**Sparse specialists earn depth.** A reviewer that fires on a small fraction of
changes can afford deep reasoning, and usually needs it: rarely-exercised
surfaces accumulate subtle failure modes and there is no second reviewer primed
for them. Say so explicitly in the mandate — tell the reviewer *why* it runs
deep and that no one else covers its surface. A mandate that explains the
reviewer's reason for existing produces measurably better engagement than one
that only lists patterns.

---

## 3.5 The evidence gate

Every finding a reviewer emits MUST carry:

1. **A concrete failure scenario** — "when input X arrives, the code does Y,
   producing wrong state Z." For security findings, an attacker model: who,
   with what access, achieving what.
2. **A cited location** in the changed code or in code the change activates.
3. **A verifiable mechanism** — something the coordinator can check by reading
   the cited code.

A finding without a failure scenario is an opinion. The coordinator will
suppress it, and the reviewer has spent tokens to produce noise.

Reviewers SHOULD over-report at the *confidence* boundary and under-report at
the *evidence* boundary: emit the finding you are unsure about if you can state
its mechanism; do not emit the finding you feel strongly about but cannot
anchor.

---

## 3.6 The reviewer output contract

Every reviewer returns exactly one JSON object. Schema:
`harness/schema/specialist-output.schema.json`.

```jsonc
{
  "reviewed": true,
  "files_reviewed": ["path/a.ts", "path/b.sql"],
  "audit_rows_reviewed": ["<audit-source>: <row-label>"],
  "summary": "One-line conclusion in your own words — what you inspected and what you concluded.",
  "candidates": [
    {
      "candidate_ref": "c1",
      "title": "short, descriptive",
      "severity": "P0 | P1 | P2 | P3",
      "category": "<one of the ten categories>",
      "confidence": "low | medium | high",
      "evidence": [
        {
          "path": "repo/relative/path.ts",
          "line": 42,
          "side": "RIGHT",
          "start_line": null,
          "start_side": null,
          "diff_hunk": "exact hunk content",
          "symbol": "functionName"
        }
      ],
      "details": "Concrete failure scenario + cited evidence."
    }
  ]
}
```

### Constraints — each is a rejection condition

| Field | Rule | On violation |
|---|---|---|
| `reviewed` | MUST be boolean `true`. | Reject as reviewer failure. |
| `files_reviewed` | MUST be an array. Empty is legal when the reviewer worked from the shared diff alone. | Reject if absent or not an array. |
| `audit_rows_reviewed` | MUST be an array naming every in-scope audit row discharged. `[]` only when no in-scope rows exist. Rows reported as findings still appear here. | Reject as reviewer failure. |
| `summary` | MUST be present, ≥ 10 characters. Longer than the cap is truncated, not rejected. | Reject if absent or too short. |
| `category` | For a topic reviewer, MUST equal its own lane. | Scope violation — coordinator may reject the candidate. |
| `candidate_ref` | Response-local. The orchestrator namespaces it as `<persona-id>:<ref>`. | — |
| `candidates` | Empty array is a correct, complete result. | — |

**`reviewed: true` is the anti-silence mechanism.** It forces an affirmative
statement of engagement, so a reviewer that failed cannot be mistaken for one
that found nothing. Anything other than boolean `true` — `false`, missing,
string `"true"` — is a failure. See Part 7.

**`summary` is required even when `candidates` is empty**, and it surfaces in
the final report. A reader must be able to see *what a quiet reviewer actually
looked at*. "No findings" from a reviewer that inspected the right surface and
"no findings" from one that misread its scope are very different results, and
only the summary distinguishes them.

**Do not invent findings to fill space.** A quiet reviewer that is right is
worth more than a noisy one that is mostly wrong. State this in the mandate.

### Anchor rules

- **Single-line inline:** `line` set, `side` set, `start_line` and `start_side`
  null.
- **Multi-line inline:** `line` set, `side` set, `start_line` set, `start_side`
  set, with `start_line <= line`.
- **File-only:** `line`, `side`, `start_line`, `start_side` all null.
- Line numbers are 1-based positive integers.

The multi-line rule matters: a range anchor missing its `start_side` is
rejected by most review APIs, and the failure surfaces at publication time —
long after the tokens were spent.

---

## 3.7 Dispatch

**Parallel by default.** Reviewers are independent, so run them concurrently.
Wall-clock for the council is the slowest reviewer, not the sum.

**Shared setup must be serialized.** When reviewers share a workspace checkout
or a prepared packet directory, guard the setup with a lock. Idempotent setup
functions are not sufficient: concurrent processes creating, reusing, or
removing the same working tree race in ways that fail intermittently and
irreproducibly. Establish an explicit happens-before edge — setup completes,
*then* model calls begin — and give each reviewer a disjoint output directory.

**Per-reviewer failure isolation.** One reviewer's failure MUST NOT abort the
council. It is recorded and the rest proceed. Part 7.

**Deadline.** The turn carries a wall-clock budget. On expiry, the orchestrator
proceeds with whatever completed and records the rest as failures. It MUST NOT
report a deadline-truncated run as complete.

**Candidate namespacing.** Two reviewers both emitting `c1` must not collide.
Namespace every reference as `<persona-id>:<candidate_ref>` before the
coordinator sees it.

**Retention.** Per-reviewer raw output MUST be retained separately from the
coordinator's output, for every run.

This last point is not bookkeeping. When a council-composition change loses a
finding, the *only* question that matters is whether the finding disappeared
before or after adjudication:

- Still present in a reviewer's candidates but absent from the final output →
  the coordinator deduplicated or suppressed it. Investigate adjudication.
- Absent from every reviewer's candidates → a reviewer stopped emitting it,
  usually because a newly-added persona's hard scope fence caused an existing
  reviewer to defer. Investigate lane boundaries.

The two failures have completely different fixes, and looking only at final
output cannot distinguish them.
