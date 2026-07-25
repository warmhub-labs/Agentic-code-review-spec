# Part 1 — The Review Request

**The input contract, and how the packet is prepared**

---

## 1.1 Why the input is prepared deterministically

Reviewers are expensive and non-reproducible. Every byte of variance you can
remove before the first token is spent is variance you never have to debug.
Packet preparation is therefore a pure, deterministic function: the same change
plus the same policy produces a byte-identical packet.

This buys three things:

1. **Replay.** A recorded review request can be re-run against a new
   configuration and the difference attributed to the configuration, not the
   input.
2. **Caching and skip decisions.** If the packet is identical to the last one,
   there is nothing new to review (Part 6).
3. **A defined attack surface.** Filtering, redaction, and trust classification
   all happen here, once, rather than being re-litigated inside every reviewer
   prompt.

---

## 1.2 The `ReviewRequest` contract

The complete input to a review run. Schema:
`harness/schema/review-request.schema.json`.

```jsonc
{
  "schema_version": "1.0.0",

  "change": {
    "id": "string",                  // opaque change identifier
    "title": "string",
    "description": "string",         // UNTRUSTED
    "author": "string",
    "base_ref": "string",
    "base_sha": "string",
    "head_sha": "string",
    "merge_base_sha": "string"
  },

  "workspace": {
    "root": "string",                // absolute path to a read-only checkout at head_sha
    "base_root": "string | null"     // optional checkout at base_sha
  },

  "diff": {
    "unified": "string",             // full base...head unified diff, UNTRUSTED
    "incremental": "string | null",  // diff since the last reviewed head, if any
    "changed_files": [
      {
        "path": "string",
        "status": "added | modified | removed | renamed",
        "previous_path": "string | null",
        "additions": 0,
        "deletions": 0,
        "binary": false,
        "generated": false           // set by the filter in §1.4
      }
    ]
  },

  "policy": { /* the routing + publication policy document — see Part 2 */ },

  "trusted_context": {
    "instruction_files": [           // from the BASE revision only — see §1.6
      { "path": "string", "content": "string" }
    ],
    "reference_docs": [
      { "path": "string", "content": "string" }
    ]
  },

  "deterministic_audit": {
    "rows": [
      {
        "label": "string",           // stable, compact, human-readable
        "source": "string",          // which audit produced it
        "path": "string | null",
        "line": 0,
        "severity": "P0 | P1 | P2 | P3",
        "kind": "finding | review-required",
        "detail": "string"
      }
    ]
  },

  "prior_state": {
    "ledger": null,                  // Ledger | null — see Part 6
    "author_replies": [
      { "thread_id": "string", "finding_id": "string", "author": "string", "body": "string" }
    ]
  },

  "run": {
    "run_id": "string",
    "trigger": "initial | code_changed | comment | manual | scheduled",
    "actor": "string",
    "deadline_ms": 0                 // wall-clock budget for the whole turn
  }
}
```

**Obligations.**

- The implementation MUST treat `change.title`, `change.description`,
  `diff.unified`, all `changed_files[].path` values, and all
  `prior_state.author_replies[].body` values as untrusted (§1.6).
- The implementation MUST NOT require network access to fulfil a review
  request. Everything needed is in the request or the workspace.
- `workspace.root` MUST be treated as read-only. See §1.7.
- Unknown fields MUST be ignored, not rejected — the contract is
  forward-extensible.

---

## 1.3 The packet

The **packet** is what model-driven reviewers actually see. It is derived from
the review request, and it is smaller than the review request in three ways:
filtered, redacted, and role-scoped.

A packet contains:

| Section | Contents | Notes |
|---|---|---|
| Change metadata | id, title, description, author, base/head refs | Prefixed with an explicit untrusted-content marker |
| Filtered diff | The unified diff after §1.4 filtering and §1.5 redaction | The primary review surface |
| Changed-file inventory | Paths, statuses, line counts | Lets a reviewer decide what to open |
| Instruction tree | Paths of base-revision instruction files relevant to changed paths | Content is read via tools, not inlined, to bound prompt size |
| Deterministic audit rows | Rows in the reviewer's scope | Mandatory disposition — see §1.8 |
| Role mandate | The reviewer's own persona definition | Part 3 |
| Turn context | Turn state, publication policy summary | Coordinator only |
| Ledger projection | Bounded summary of prior findings | Coordinator only — Part 6 |

**Reviewers other than the coordinator MUST NOT receive the ledger, prior
findings, other reviewers' candidates, or author replies.** Lane independence is
what makes the council's diversity real (Part 3, §3.3).

---

## 1.4 Diff filtering

Before the diff reaches any model, remove content that consumes context without
carrying review signal. Filtering is deterministic and its decisions are
recorded.

**MUST filter out** (replace the hunk body with a one-line elision marker
stating path and line count):

- Lockfiles: `package-lock.json`, `bun.lock`, `bun.lockb`, `yarn.lock`,
  `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `poetry.lock`, `composer.lock`,
  `Gemfile.lock`, `mix.lock`, and their nested equivalents.
- Minified and bundled output: `*.min.js`, `*.min.css`, `*.bundle.js`, `*.map`.
- Binary files (identified by content, not extension).
- Vendored dependency trees and build output directories declared in policy.

**MUST NOT filter** — even when a path pattern would otherwise match:

- Anything under a migrations directory. Migration files are frequently
  generated *and* are the highest-consequence surface in the system. Generated
  is not the same as unimportant.
- Instruction files (`AGENTS.md`, `CLAUDE.md`, persona definitions, policy
  documents). These are reviewed as changes even though they are never obeyed
  as instructions (§1.6).

**Elision markers** MUST be visible to the reviewer:

```
<elided: bun.lock — 1,204 lines changed, filtered as lockfile>
```

A reviewer that cannot see *that* something was elided may reason incorrectly
about the completeness of the change. Silent elision is a defect.

**Large-file truncation.** A single file's diff exceeding the policy's
per-file byte cap is truncated deterministically: keep the first N bytes and the
last M bytes, replace the middle with a marker that states how many bytes were
omitted and includes a hash of the omitted region. The reviewer can retrieve
specific ranges through the read tool.

---

## 1.5 Secret detection — detector, not masker

A secret scanner runs over **change-added content only** (added and modified
lines; never base-revision content) *before* any model invocation.

When it fires:

1. The orchestrator emits a `P0` / `security` finding **directly into the
   result**, bypassing the model entirely. `confidence` is set to `high`
   automatically.
2. The finding uses **location-only evidence**. It cites `path:line` and names
   the secret class (AWS key, provider token, private key, JWT, connection
   string with embedded credentials, high-entropy literal). It MUST NOT quote
   the matched bytes — not in the finding, not in logs, not in any persisted
   artifact.
3. The secret-bearing line in the model-bound diff is replaced with:
   `<line redacted: P0 finding emitted directly>`

The model therefore learns that a P0 was raised and never sees the secret.

**Why detector rather than masker.** A silent mask makes the system's most
important single finding invisible. The scanner's job is to raise an alarm, not
to clean up quietly.

**Minimum detector classes.** Provider API keys with recognizable prefixes;
cloud access-key identifiers and their high-entropy secret counterparts;
three-segment dotted JWTs; PEM private-key blocks (including line-broken
forms); connection URLs with inline credentials; generic high-entropy strings
above a configured length (emitted at `confidence: medium` — this class is a
weak signal and MUST be gradeable down by the coordinator).

**False positives** are handled downstream, not by weakening the detector: the
author disputes, and the disposition rules in Part 6 allow a waiver.

---

## 1.6 Trust boundary

**Trusted instruction sources — the base revision only:**

- Repository instruction files (`AGENTS.md`, `CLAUDE.md`, or equivalent) as they
  exist at `base_sha`.
- Persona definitions.
- The routing/publication policy document.
- Reference documentation the personas are configured to consult.

**Untrusted — reviewed as content, never obeyed:**

- Everything in the diff, including instruction files the change adds or
  modifies.
- Change title, description, branch name, commit messages.
- File paths and directory names.
- Author replies on review threads.
- Linked issue or ticket bodies.

**The hard rule:** a change that modifies an instruction file gets that file
reviewed as a changed file. The current review continues to use base-revision
instructions. New instructions take effect on the next review that runs against
a base containing them.

This is strictly safer than trying to decide, per change, whether a modified
instruction file is benign — and it is far easier to reason about.

**Prompt-injection classification.** A scanner examines the diff for
instruction-shaped content directed at a reviewer. Its response depends on
*where* the content sits:

| Surface | Response |
|---|---|
| **Trusted-instruction surface** — an instruction file, persona definition, or policy document that the change modifies | Emit a `P1` `security` finding at the source location. Injected content MAY be quoted in the finding details, escaped. |
| **Artifact surface** — test fixtures, documentation examples, string literals in source, security-training content | Record as observed for analytics. **Emit no finding.** |

The second row matters more than it looks. A repository that legitimately
contains prompt-injection test fixtures must not generate a finding every time
those fixtures are touched. The defense against artifact-surface injection is
not detection — it is that reviewers treat *all* diff content as untrusted by
construction.

**Post-processing sanitation.** Before any finding is rendered or persisted,
strip zero-width characters, bidirectional-override control characters, and
unusual unicode escapes from finding titles and details.

---

## 1.7 Workspace sandbox

Reviewers get read-only, sandboxed access to the workspace at head. This is
essential: the most common missed-defect class is *"the diff looks fine in
isolation but combines unsafely with code in a file the reviewer never opened."*
A reviewer restricted to the diff cannot find those.

The sandbox MUST enforce:

- All paths resolved against the workspace root; path traversal outside the root
  is refused.
- Symlinks whose targets resolve outside the root are refused.
- Submodules are not followed automatically.
- **No process execution. No network access. No writes.**
- Bounded reads: a maximum bytes-per-call and a maximum files-per-turn.
- Binary reads refused unless the path matches an explicit allowlist.
- Bounded search: a maximum match count, and a cap on pattern complexity.

**Refusals return a structured marker, not an error.** A refused read tells the
reviewer "this path exists and was not consumed" — which is information — rather
than throwing, which is a dead end. A reviewer that receives an error may
conclude the file does not exist and reason wrongly.

Available tools SHOULD be exactly: read a file, search file contents, expand a
path glob, list a directory. Nothing else.

---

## 1.8 Deterministic audit rows

Static analysis, custom lints, and structural invariant checks run before the
review and produce **audit rows**. Rows are not findings. They are *mandatory
dispositions*.

Rules:

- Each row carries the severity declared by the rule that produced it. Rows are
  **never** auto-promoted to a uniform severity.
- **A row is in a reviewer's scope when its `path` is among the changed files
  that reviewer received.** Rows carry no category and are therefore never
  lane-filtered: a row in scope is in scope for *every* dispatched reviewer, and
  a row with a null `path` is in scope for all of them.
- Every in-scope row MUST be explicitly discharged by each reviewer that
  received it: accepted as a finding, downgraded with a reason, or dismissed
  with a reason.
- **Rows are identified by their `label`, verbatim.** The label is the discharge
  key that appears in `audit_rows_reviewed` and in the coordinator's
  `audit_row_dispositions`. Implementations MUST NOT re-derive, normalize, or
  abbreviate it.

This definition is deliberately broad, and the cost is real: on a lint-heavy
repository every reviewer discharges every row, which is redundant token spend.
The alternative — lane-filtering rows by category — requires a category the row
does not carry, and inventing one silently drops rows nobody then discharges.
Breadth is the safe direction; the fix, if the cost matters, is to give rows a
lane in the audit format rather than to guess at one here.

Earlier versions said only "every row in a reviewer's scope" and never defined
scope. Four independent implementations each had to guess, all four arrived at
this same reading, and all four recorded it as an ambiguity — a strong signal
that the reading is right and that leaving it unstated was the error.
- A reviewer that does not account for every in-scope row is a **failure**, not
  a clean pass (Part 7).
- If the coordinator drops a row without dispositioning it, the orchestrator
  re-emits the row at its rule-declared severity. Silence does not dismiss.

This is the mechanism that lets cheap deterministic checks bind expensive
stochastic reviewers. It is also the primary path by which a run's token spend
converts into a permanent, deterministic check: a defect class that recurs gets
a lint rule, the lint rule emits an audit row, and the row is thereafter
discharged for free.

---

## 1.9 Packet reproducibility

The implementation MUST expose a **packet digest**: a stable hash over the
prepared packet's semantic content — filtered diff, changed-file inventory,
audit rows, policy, persona set, and the instruction-file tree at base.

The digest MUST NOT include the head revision identifier, the run identifier,
the trigger, or the timestamp. A rebase or squash that produces an identical
tree therefore produces an identical digest, and the system correctly recognizes
that there is nothing new to review even though the head identifier changed.

The digest is the first axis of the skip decision in Part 6.
