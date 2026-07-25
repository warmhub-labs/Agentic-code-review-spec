# Part 8 — Ports

**Interfaces to the outside world**

---

## 8.1 Why ports

Everything outside the two wire contracts is a **port**: a named interface with
defined obligations and an in-memory fake. The core never talks to a code-hosting
platform, a model provider, a telemetry backend, or a database directly.

This is not architectural decoration. It is what makes the system testable
without spending money: the entire orchestrator, state machine, post-processor,
publication policy, and ledger merge run against fakes in milliseconds,
deterministically, with no provider dependency. In the reference implementation
the complete integration suite — dozens of scenarios covering state transitions,
anchor demotion, reversal rejection, override firing, and stale-run aborts —
runs in under two seconds.

An implementation MUST provide a working fake for every port. The conformance
suite (Part 9) runs entirely on fakes.

---

## 8.2 `ModelAgent`

Invokes a model with a persona configuration and returns structured output.

```
ask({
  role, systemPrompt, userPrompt,
  schema?,                       // JSON Schema for structured output
  tools?,                        // read | grep | glob | ls
  provider, model, thinkingLevel,
  sessionDir?, timeoutMs?
}) -> {
  json, sessionPath, durationMs,
  inputTokens?, outputTokens?, cost?
}
```

**Obligations.**

- Every call site declares **provider, model, and thinking level explicitly**.
  No implicit defaults at the call site — defaults live in the persona document
  and in the tier policy, where they are visible and versioned.
- When `schema` is supplied, the adapter is responsible for obtaining conforming
  output, including retry. Schema violations surface to the caller as failures,
  not as silently repaired output.
- Timeouts return a failure, not a partial result.
- Token counts and cost are captured **for failed calls too** (Part 7 §7.9).
- The session transcript path is returned, so §7.4 salvage and post-hoc audit
  are possible.

**The fake** returns scripted output keyed on `(role, packet_digest, model)`.
This gives every conformance scenario a deterministic, free, instant model.

**Library over subprocess.** Prefer a direct library integration to wrapping a
CLI. Subprocess wrapping costs process overhead per reviewer, makes structured
output a parsing problem rather than a contract, and makes cost and token
accounting a scraping exercise. Where a CLI *is* the only available substrate,
the transcript-salvage path in Part 7 §7.4 becomes load-bearing rather than
belt-and-braces.

---

## 8.3 `ChangeProvider`

Reads change metadata, diffs, and review threads; publishes results.

```
getChange(id)                  -> ChangeMetadata
getDiff(id, base, head)        -> UnifiedDiff
getChangedFiles(id)            -> ChangedFile[]
getThreads(id)                 -> Thread[]
getReplies(id, since)          -> Reply[]

publishReview(id, {
  body, event,                 // COMMENT | REQUEST_CHANGES
  comments: InlineComment[]
})                             -> PublishResult

resolveThread(threadId)        -> void        // best-effort
unresolveThread(threadId)      -> void        // best-effort
dismissPriorReview(reviewId)   -> void        // best-effort
getRateBudget()                -> { core, graphql }
```

**Obligations.**

- The review event value is **computed deterministically** from the validated
  finding set: any open blocking finding → `REQUEST_CHANGES`; otherwise
  `COMMENT`. The reviewer never emits an approval — approval is a separate
  concern with a separate authority.
- Inline comments carry validated anchors only (`anchor_status: current_diff`).
- Thread mutations are best-effort and individually wrapped. Failures log drift
  and continue.
- The port never edits prior published comments. It posts new reviews; thread
  state moves by resolution. The single exception is a marker comment that
  carries the ledger digest, which is updated in place and never duplicated.
- `getRateBudget` supports the pre-flight check in Part 6 §6.8.

**The fake** records calls in memory and returns configurable success or
failure, so publication-failure paths are testable.

---

## 8.4 `Workspace`

Read-only, sandboxed repository access. Obligations are specified in Part 1
§1.7.

```
read(path, {maxBytes?})        -> Content | RefusalMarker
search(pattern, {maxMatches?}) -> Match[]  | RefusalMarker
glob(pattern)                  -> string[]
list(dir)                      -> Entry[]
```

Refusals return **structured markers, never exceptions**. A reviewer receiving
an error may conclude the path does not exist; a reviewer receiving "refused:
outside workspace root" knows the file exists and was not consumed, which is
different and actionable information.

---

## 8.5 `LedgerStore`

Persists the per-change ledger.

```
load(changeId)                 -> { ledger, digest } | null
save(changeId, ledger, expectedPriorDigest) -> { digest } | StaleError
```

**Obligations.**

- `save` is **compare-and-set** on the prior digest. A mismatch returns a stale
  error and the caller aborts publication (Part 6 §6.4). This is the concurrency
  guarantee the whole multi-turn design rests on.
- The store MUST tolerate loss. A missing ledger is not an error; it triggers the
  conservative fresh-start path in Part 6 §6.4.
- Ledger content may contain repository excerpts and suppression reasons.
  Retention and access policy are deployment concerns, but the implementation
  MUST document them, and MUST NOT persist secret values (Part 1 §1.5).

---

## 8.6 `TelemetrySink`

Emits spans and metrics per run.

```
startSpan(name, attrs)         -> Span
recordMetric(name, value, attrs)
```

**Recommended span tree**, because this shape is what makes cost and latency
attributable:

```
review.turn
├── routing.classify
├── packet.prepare
├── council.dispatch
│   ├── council.reviewer   (one per reviewer, incl. failures)
│   └── council.coordinator
├── postprocess
└── publish
```

**Required attributes** on the turn span: change id, tier, static floor, fired
overrides, turn state, declared/returned/failed reviewer counts, coordinator
source, finding counts by severity, total cost, total duration, deadline-exceeded
flag.

**Required per-reviewer attributes**: persona id, model, thinking level, status,
duration, cost, candidate count, whether salvaged.

Instrument per-reviewer cost even for failures. A council whose expensive
reviewer times out half the time is not cheap, and only per-reviewer failure
accounting shows it.

---

## 8.7 `EvidenceLedger` — the self-improvement port

The reference system writes every run's findings into a durable, queryable
store, and this is the mechanism by which token spend becomes an investment
rather than a cost.

**Specified here as an interface only.** The store's shape and query language
are deployment choices.

```
recordRun(runSummary)
recordFinding(findingRecord)
recordGateDecision(decision)
recordPostMergeSignal(signal)   // field escapes: what got through
```

**What makes it useful:**

- Findings are recorded with enough structure to be **clustered into reusable
  issue classes** later — category, path, the mechanism described, the reviewer
  that found it, whether it was confirmed by a subsequent fix.
- **Field escapes feed back.** Defects found in production after review are
  recorded against the review that missed them. This is the only source of
  ground truth about false negatives; a corpus built purely from what the system
  found can never measure what it did not.
- Gate decisions are recorded alongside findings, so the relationship between
  what was found and what shipped is queryable.

**The loop this enables:** recurring issue classes become deterministic checks;
deterministic checks emit audit rows (Part 1 §1.8); audit rows are discharged for
free on every subsequent run. Each defect class the system pays to discover
stochastically once becomes a check it enforces deterministically thereafter.

**Why recall alone cannot close this loop.** A regression suite built from
historical findings gates against *known* regressions only — by construction it
cannot detect a defect class the system has never caught. That is precisely why
field escapes must be a first-class input. A system whose only evaluation signal
is historical recall will hill-climb toward reproducing its own past behavior,
including its past blind spots.

---

## 8.8 Port summary

| Port | Required for | Fake required |
|---|---|---|
| `ModelAgent` | Everything | Yes |
| `Workspace` | Reviewer verification beyond the diff | Yes |
| `ChangeProvider` | Production deployment only | Yes |
| `LedgerStore` | Multi-turn (Part 6) | Yes |
| `TelemetrySink` | Cost/latency analysis | Yes (no-op acceptable) |
| `EvidenceLedger` | Self-improvement loop | Yes (no-op acceptable) |

A single-turn implementation needs `ModelAgent` and `Workspace`. Everything else
may be a no-op fake and the implementation still conforms for the single-turn
evaluation track.
