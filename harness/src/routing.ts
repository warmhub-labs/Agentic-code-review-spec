// Reference router.
//
// Two jobs: the seeder uses it to COMPUTE each case's expected routing (rather
// than trusting a hand-written value, which is how ground truth silently rots),
// and the scorer uses it to grade a candidate's routing accuracy.
//
// Glob semantics are stated here once and tested, per spec/02-risk-routing.md
// §2.3 — pattern-semantics drift is a silent routing regression.

export type Tier = 'low' | 'medium' | 'high' | 'critical'

export const TIER_ORDER: Tier[] = ['critical', 'high', 'medium', 'low']
export const TIER_RANK: Record<Tier, number> = { low: 0, medium: 1, high: 2, critical: 3 }

/**
 * Glob matching. Semantics, fixed:
 *
 *  - `*` and `**` both match any run of characters INCLUDING `/`.
 *  - `?` matches exactly one character.
 *  - A leading `**​/` is optional, so `**​/*.md` matches both `docs/a.md` and
 *    root-level `README.md`. This is the behaviour every glob implementation
 *    people expect, and omitting it silently drops root-level files from
 *    every recursive pattern.
 *  - Matching is anchored at both ends.
 */
export function fnmatch(path: string, pattern: string): boolean {
  if (matchAnchored(path, pattern)) return true
  if (pattern.startsWith('**/')) return matchAnchored(path, pattern.slice(3))
  return false
}

function matchAnchored(path: string, pattern: string): boolean {
  let rx = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      // Collapse a run of '*' into a single "any characters, including /".
      while (pattern[i + 1] === '*') i++
      rx += '.*'
    } else if (ch === '?') {
      rx += '.'
    } else {
      rx += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${rx}$`).test(path)
}

export function computeStaticFloor(
  changedFiles: readonly string[],
  riskTierRules: Record<string, readonly string[]>,
): { floor: Tier; matchedRules: string[] } {
  const matchedRules: string[] = []
  let floor: Tier = 'low'
  for (const tier of TIER_ORDER) {
    const patterns = riskTierRules[tier] ?? []
    for (const p of patterns) {
      for (const f of changedFiles) {
        if (fnmatch(f, p)) {
          matchedRules.push(`${tier}:${p}`)
          if (TIER_RANK[tier] > TIER_RANK[floor]) floor = tier
          break
        }
      }
    }
  }
  // Highest match wins; `**` at the low tier guarantees a classification.
  return { floor, matchedRules }
}

export function enforceRiskFloor(proposed: Tier, floor: Tier): Tier {
  return TIER_RANK[proposed] >= TIER_RANK[floor] ? proposed : floor
}

type Override = {
  test: readonly string[]
  exclude?: readonly string[]
  appliesTo: '*' | readonly string[]
  match?: 'every' | 'any'
  skipWhenCouncilEmpty?: boolean
  effect?: Record<string, unknown>
  addCouncil?: readonly string[]
}

function inScope(file: string, o: Override): boolean {
  return (
    o.test.some((p) => fnmatch(file, p)) && !(o.exclude ?? []).some((p) => fnmatch(file, p))
  )
}

function scopeMatches(changedFiles: readonly string[], o: Override): boolean {
  if (changedFiles.length === 0) return false // never fires on an empty change
  return (o.match ?? 'every') === 'any'
    ? changedFiles.some((f) => inScope(f, o))
    : changedFiles.every((f) => inScope(f, o))
}

export type DispatchPlan = {
  tier: Tier
  matchedRules: string[]
  overrides: string[]
  council: string[]
  effective: Record<string, unknown>
}

export function classifyDispatch(
  changedFiles: readonly string[],
  policy: {
    riskTierRules: Record<string, readonly string[]>
    dispatchPolicy: Record<string, Record<string, unknown>>
    dispatchOverrides?: Record<string, Override>
    subtractEnabled?: Record<string, boolean>
  },
  opts: { auditHasP0orP1?: boolean } = {},
): DispatchPlan {
  const { floor, matchedRules } = computeStaticFloor(changedFiles, policy.riskTierRules)
  const base = policy.dispatchPolicy[floor]
  if (!base) throw new Error(`policy is missing dispatchPolicy.${floor}`)

  let effective: Record<string, unknown> = { ...base }
  const fired: string[] = []

  for (const [name, o] of Object.entries(policy.dispatchOverrides ?? {})) {
    if (o.appliesTo !== '*' && !o.appliesTo.includes(floor)) continue
    if (!policy.subtractEnabled?.[name]) continue
    if (!scopeMatches(changedFiles, o)) continue

    const subtractive = (o.match ?? 'every') === 'every'
    // Safety interlock: cheap deterministic evidence of a problem outranks a
    // policy that says the change is boring.
    if (subtractive && opts.auditHasP0orP1) continue
    // Do not rehydrate a council a prior override deliberately emptied.
    if (
      o.skipWhenCouncilEmpty &&
      Array.isArray(effective.council) &&
      (effective.council as string[]).length === 0
    ) {
      continue
    }

    effective = { ...effective, ...(o.effect ?? {}) }
    if (o.addCouncil?.length) {
      effective = {
        ...effective,
        council: [...((effective.council as string[]) ?? []), ...o.addCouncil],
      }
    }
    fired.push(name)
  }

  return {
    tier: floor,
    matchedRules,
    overrides: fired,
    council: (effective.council as string[]) ?? [],
    effective,
  }
}
