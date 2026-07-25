# Part 2 — Risk Classification and Routing

**Deciding how much attention a change deserves, before any model runs**

---

## 2.1 The premise

Not every change deserves the same scrutiny. A typo fix in a README and a
fifty-line change to authorization logic have quantitatively different risk
profiles, and attention spent on the first is attention stolen from the second.

Routing is the cheapest component in the system and it shapes every downstream
cost. It is also the only component that runs on **every** change with no
variance. Get it right and everything else gets cheaper; get it wrong and no
amount of reviewer quality recovers the loss.

---

## 2.2 The tier taxonomy

Four tiers, ordered: `low` < `medium` < `high` < `critical`.

Tiers answer one question: *how much review effort does this change warrant?*
They are deliberately **not** the same axis as "how strict is the merge gate."
An implementation MAY reuse one policy document for both, but the two decisions
MUST remain separable — the reference system carries a `dispatchPolicy` and a
`mergePolicy` in the same file and they are read by different consumers.

---

## 2.3 The static floor

The tier is computed from **changed file paths alone**, against ordered
glob-pattern rules.

```
computeStaticFloor(changedFiles, riskTierRules) -> { floor, matchedRules }
```

Rules:

- Evaluate tiers in descending order of severity (`critical`, then `high`, then
  `medium`, then `low`). **Highest match wins.** One file matching a `critical`
  pattern makes the whole change `critical`, regardless of what else it touches.
- A catch-all `**` pattern at the `low` tier guarantees every change classifies.
- **Glob semantics are fixed by this specification.** They are not an
  implementation choice:

  | Token | Meaning |
  |---|---|
  | `*` | Any run of characters, **including `/`** |
  | `**` | Identical to `*`; a run of `*` collapses to one |
  | `?` | Exactly one character |
  | leading `**/` | **Optional.** `**/*.md` matches `docs/a.md` *and* root-level `README.md` |
  | anything else | Literal, matched case-sensitively |

  Matching is anchored at both ends. Paths are repository-relative with no
  leading separator.

  Two consequences are easy to get wrong and both change routing. `*` spanning
  `/` means `sites/docs/*.ts` matches at any depth — a pattern that looks
  single-level is not. And an optional leading `**/` is what keeps root-level
  files inside recursive patterns; without it, `**/*.md` silently excludes
  `README.md`, and a docs-only override stops firing on exactly the changes it
  was written for.

  An earlier version of this section left the choice to the implementer and
  asked only that it be documented and tested. Four independent implementations
  each defined their own, and each recorded it as an ambiguity. A routing
  decision that varies by implementation is not a routing decision — it is the
  first input to every downstream cost, and it must be identical everywhere.
- The function returns both the floor and the list of matched rules. The matched
  rules go into the run record; unexplainable routing is unfixable routing.

**Worked example** (from the reference policy):

| Tier | Patterns |
|---|---|
| `critical` | *(empty — reserved)* |
| `high` | `packages/backend/src/db/schema.ts`, `packages/backend/drizzle/**`, `packages/backend/src/stream/**`, `packages/backend/src/commit/**`, `packages/backend/src/workspace/overlay.ts` |
| `medium` | `packages/backend/src/**`, `packages/sdk-ts/src/**` |
| `low` | `**` |

A change touching `packages/backend/src/db/schema.ts` and a README is `high`,
because the highest match wins.

---

## 2.4 Promote-only

Later stages may **promote** a change to a higher tier. Nothing may demote it
below the static floor.

```
enforceRiskFloor(proposedTier, staticFloor) =
    rank(proposedTier) >= rank(staticFloor) ? proposedTier : staticFloor
```

The coordinator may observe a security problem on a `medium` change and mark
subsequent turns `high`. It may never conclude that a change touching the
schema is really `low`. The floor is a floor.

---

## 2.5 The dispatch policy

For each tier the policy declares:

```jsonc
{
  "council": ["reviewer-id", "..."],       // which reviewers run on a first review
  "councilParallel": true,
  "personaThinkingOverrides": {            // per-reviewer depth override for this tier
    "reviewer-id": "xhigh"
  },
  "finalFreshCouncil": ["reviewer-id"],    // which reviewers run in the merge-time fresh read
  "coordinator": {                         // per turn-state model + depth
    "initial":          { "provider": "...", "model": "...", "thinkingLevel": "xhigh" },
    "fix_verification": { "...": "high" },
    "author_response":  { "...": "low" },
    "convergence":      { "...": "high" },
    "final_fresh":      { "...": "xhigh" }
  },
  "maxProjectionTokens": 8000,             // ledger-projection cap — Part 6
  "publication": {                         // per turn-state severity gate — Part 5
    "INITIAL":                { "publish": ["P0","P1","P2","P3"], "p3Cap": 15,
                                "reversalHandling": "require_justification" },
    "FIX_VERIFICATION":       { "publish": ["P0","P1","P2"],
                                "reversalHandling": "require_justification" },
    "AUTHOR_RESPONSE_REVIEW": { "publish": [],
                                "reversalHandling": "auto_retract" },
    "CONVERGENCE":            { "publish": ["P0","P1"],
                                "reversalHandling": "require_justification" },
    "FINAL_FRESH":            { "publish": ["P0","P1","P2"],
                                "reversalHandling": "allow_independent" }
  },
  "halt": {                                // convergence rules — Part 6
    "zeroOpen": ["P0","P1"],
    "zeroNewThisTurn": ["P0","P1"],
    "maxTurns": 12
  },
  "stateMachine": { "skipStates": [], "mandatoryStates": ["FINAL_FRESH"] }
}
```

Note the shape of the reference defaults: **the council barely shrinks as the
tier drops.** Low-tier changes run nearly the same reviewer set as high-tier
ones; what varies is coordinator depth, publication permissiveness, the P3 cap,
and the turn budget. That is a deliberate recall-over-cost stance, and it is the
right default until you have replay evidence that a smaller council loses
nothing (§2.8).

---

## 2.6 Overrides

Overrides are named, independently-gated modifiers applied on top of the tier's
base policy. Each has a **kill switch** — a per-family boolean that must be true
for the override to fire at all. Kill switches ship `false` and flip
individually, each with its own evidence.

```jsonc
"dispatchOverrides": {
  "<family-name>": {
    "test":      ["glob", "..."],       // scope patterns
    "exclude":   ["glob", "..."],       // carve-outs from scope
    "appliesTo": ["low","medium"],      // tiers this may modify, or "*" for all
    "match":     "every",               // "every" (default) or "any" — see below
    "skipWhenCouncilEmpty": true,       // optional guard, see below
    "effect":     { /* fields to REPLACE on the tier policy */ },
    "addCouncil": ["reviewer-id"]       // reviewers to APPEND to the council
  }
}
```

### Match semantics — the important part

`match` controls the file-scope predicate, and the two modes exist for opposite
purposes:

- **`every` (default, subtractive).** The override fires only when *every*
  changed file is in scope. Used to *shrink* the review — "this change is
  nothing but documentation, skip the council." A mixed change falls back to the
  base tier. This is the conservative direction: a subtractive override must
  never fire on a change it only partly understands.
- **`any` (additive).** The override fires when *at least one* changed file is
  in scope. Used to *add* a topic reviewer — "this change touches a migration,
  add the migration-safety reviewer." Additive overrides SHOULD set
  `appliesTo: "*"`, because an additive topic reviewer's relevance is fully
  answered by its file scope; the base tier is irrelevant, and hand-listing
  tiers silently drops coverage when the same topic routes to different tiers by
  path.

The second point is a real, observed failure. In the reference repository,
migration-adjacent paths route to three different tiers depending on which
directory they live in. An additive migration reviewer restricted to
`appliesTo: ["high"]` would have missed two of them.

**An override never fires on an empty changed-file list.**

**Stacking.** Multiple overrides may fire on one change. They apply in
declaration order; `effect` replaces fields, `addCouncil` appends. An
implementation MUST record which overrides fired.

**`skipWhenCouncilEmpty`.** A guard for subtractive overrides: if applying this
override would rehydrate a council that a previously-applied override
deliberately emptied, skip it. Without this, a "shrink the council to three
reviewers" override applied after a "skip the council entirely" override
resurrects three reviewers on a pure-lockfile change.

### Reference override families

| Family | Direction | Scope | Effect |
|---|---|---|---|
| `docs_only` | subtractive (`every`) | Markdown, docs sites, changelogs — **excluding** persona files and the executable/build files of the docs application itself | Empty council. Coordinator still runs at low depth to enforce publication policy. |
| `lockfile_or_generated` | subtractive (`every`) | Lockfiles, minified/bundled output — **excluding** migrations | Empty council. The diff filter already stripped these, so the council would see an empty diff. |
| `cost_aware_low` | subtractive (`every`, scope `**`) | All low-tier changes | Shrink the council to correctness + security + testing. Deliberately trades away consistency/maintainability P2 coverage. |
| `migration_safety` | **additive** (`any`, `appliesTo: "*"`) | Migration directories, schema files, the migration runner | Append the migration-safety reviewer. |
| `ci_workflow` | **additive** (`any`, `appliesTo: "*"`) | CI workflow and configuration paths | Append the CI/workflow reviewer. |

The `docs_only` exclusion list is worth studying: markdown *content* under a
documentation site is documentation, but the site's TypeScript, build config,
and template files are deploy-critical code and must still reach the council.
Getting this carve-out wrong is how a subtractive override becomes a security
hole.

### Safety interlock

A subtractive override MUST NOT fire when the deterministic audit reports any
`P0` or `P1` row. Cheap deterministic evidence that something is wrong overrides
a policy that says "this change is boring."

---

## 2.7 The dispatch plan

Routing returns:

```jsonc
{
  "tier": "high",
  "matchedRules": ["high:packages/backend/drizzle/**"],
  "overrides": ["migration_safety"],
  "effective": { /* the tier policy after all overrides applied */ }
}
```

**Obligations.**

- Routing MUST be pure. No model calls, no network, no filesystem reads beyond
  the policy document.
- Routing MUST be deterministic and reproducible. Same inputs, same plan, byte
  for byte.
- The plan MUST be recorded in full — tier, matched rules, fired overrides, and
  the resulting effective policy — so that any routing decision can be explained
  after the fact.
- If the policy is missing a required tier entry, **fail loudly**. Do not
  silently substitute a default; a routing system that quietly degrades to
  "review everything at low effort" is worse than one that stops.

**Sanity check.** An implementation SHOULD count the non-empty patterns defined
across all tier rules and record it. A count of zero means every change will
fall through to the catch-all tier regardless of content — usually a
misconfigured or mis-parsed policy file, and otherwise invisible.

---

## 2.8 Changing routing — the evidence bar

Routing changes are the highest-leverage and highest-risk changes in the system.
Two rules, both learned by getting them wrong:

**Never infer a routing rule from historical credit.** It is tempting to mine
past review runs, find that reviewer X produced most of the confirmed findings
on path Y, and route path Y to X alone. This does not work. Credit is
*conditional on which other reviewers were in the council at the time* — X may
have been the first to emit a candidate that three others would also have found,
or the findings on fresh changes to path Y may belong to a category X was never
scoped to. Historical share-of-credit is not marginal contribution.

To use historical attribution as a routing signal you need one of:

- **Ablation runs** — each reviewer alone against the same corpus, measuring
  true marginal contribution;
- **Category labels** — confirming the dominant reviewer owns the same defect
  category the candidate changes actually present; or
- **A multi-reviewer bucket** — preserving every reviewer ever observed catching
  something on that path, sacrificing some cost saving for retention.

**Retention is the only honest test of a subtractive change.** Cost savings on a
shrunken council are trivial to fake — drop reviewers and the cost falls by
construction. Recovering the findings is the hard part. A subtractive routing
change ships only when replay shows the affected changes lose no confirmed
high-severity finding.

Each override family flips its own kill switch, with its own evidence, one at a
time. A failing family blocks only itself.
