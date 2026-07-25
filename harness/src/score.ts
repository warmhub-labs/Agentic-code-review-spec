#!/usr/bin/env bun
// Score a completed evaluation run. See protocol/scoring.md.
//
// Reports per-class recall BEFORE aggregate recall — an aggregate hides a
// missing lane, and a missing lane is the failure this corpus exists to expose.
//
// Mechanism matching (scoring.md §2, point 4) is not implemented here: it needs
// a judge model and this harness has no provider dependency by design. Structural
// matching alone OVERSTATES recall. Run both and bracket the truth; the report
// records which mode produced the numbers.
//
// Usage: bun src/score.ts --tag <tag> [--final] [--tolerance 12]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFECT_CLASSES, SEEN_CLASSES, UNSEEN_CLASSES } from './defects/index.js'

const DEFAULT_TOLERANCE = 12
const COST_CAP_USD = 5.0
const WALL_CAP_S = 900
const COMPLETION_THRESHOLD = 0.85

type Sev = 'P0' | 'P1' | 'P2' | 'P3'
const SEV_RANK: Record<Sev, number> = { P3: 0, P2: 1, P1: 2, P0: 3 }

type Finding = {
  severity: Sev
  category: string
  details: string
  title: string
  published: boolean
  evidence: { path: string; line: number | null; anchor_status: string }[]
}

type Truth = {
  case_id: string
  kind: 'defective' | 'clean'
  expected_tier: string
  expected_overrides: string[]
  expected_council_includes: string[]
  defects: {
    defect_id: string
    class: string
    path: string
    line_start: number
    line_end: number
    outside_diff: boolean
    min_severity: Sev
    expected_category: string[]
  }[]
  decoys: { decoy_id: string; path: string; line_start: number; line_end: number }[]
  inject_failure: { persona_id: string; mode: string } | null
}

function arg(flag: string, dflt?: string) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : dflt
}

function matches(f: Finding, d: Truth['defects'][number], tol: number): boolean {
  for (const e of f.evidence) {
    if (e.path !== d.path) continue
    if (!d.expected_category.includes(f.category)) continue
    if (d.outside_diff) return true // file-level anchor on the right file is enough
    if (e.line == null) continue
    if (e.line >= d.line_start - tol && e.line <= d.line_end + tol) return true
  }
  return false
}

function nearDecoy(f: Finding, k: Truth['decoys'][number], tol: number): boolean {
  return f.evidence.some(
    (e) => e.path === k.path && e.line != null && e.line >= k.line_start - tol && e.line <= k.line_end + tol,
  )
}

function pct(n: number, d: number): number {
  return d === 0 ? Number.NaN : Number((n / d).toFixed(4))
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

function main() {
  const tag = arg('--tag')
  if (!tag) {
    console.error('usage: score.ts --tag <tag> [--final] [--tolerance 12]')
    process.exit(2)
  }
  const tol = Number(arg('--tolerance', String(DEFAULT_TOLERANCE)))
  const runs = resolve(arg('--runs', join(import.meta.dir, '..', 'runs'))!)
  const corpus = resolve(arg('--corpus', join(import.meta.dir, '..', 'corpus'))!)
  const runDir = join(runs, tag)

  const manifest = JSON.parse(readFileSync(join(runDir, 'run-manifest.json'), 'utf8'))
  const split: string = manifest.split

  // Accumulators
  const perClass: Record<string, { found: number; total: number }> = {}
  for (const c of DEFECT_CLASSES) perClass[c] = { found: 0, total: 0 }

  let defectsTotal = 0
  let defectsFound = 0
  let defectsP1Total = 0
  let defectsP1Found = 0
  let cleanCases = 0
  let cleanCasesWithFinding = 0
  let cleanCaseFindings = 0
  let decoysTotal = 0
  let decoysHit = 0
  const sev = { exact: 0, over: 0, under: 0 }
  let tierOk = 0
  let overrideOk = 0
  let councilOk = 0
  let routedCases = 0
  let honestyTotal = 0
  let honestyOk = 0
  let publishedAnchors = 0
  let currentDiffAnchors = 0
  let unanchorable = 0
  const costs: number[] = []
  const walls: number[] = []
  let completionMin = 1
  let completionWorstCase: string | null = null
  const unexpectedFailures: string[] = []
  const misses: unknown[] = []
  let missingResults = 0

  for (const rec of manifest.records as { case_id: string; wall_ms: number }[]) {
    const caseId = rec.case_id
    const truth: Truth = JSON.parse(readFileSync(join(corpus, split, caseId, 'truth.json'), 'utf8'))
    const resultPath = join(runDir, caseId, 'result.json')

    // Count the corpus contribution regardless of whether a result exists — a
    // candidate that crashes must not shrink its own denominator.
    for (const d of truth.defects) {
      defectsTotal++
      perClass[d.class] = perClass[d.class] ?? { found: 0, total: 0 }
      perClass[d.class].total++
      if (SEV_RANK[d.min_severity] >= SEV_RANK.P1) defectsP1Total++
    }
    if (truth.kind === 'clean') cleanCases++
    decoysTotal += truth.decoys.length
    if (truth.inject_failure) honestyTotal++
    routedCases++

    if (!existsSync(resultPath)) {
      missingResults++
      for (const d of truth.defects) {
        misses.push({
          case_id: caseId,
          defect_id: d.defect_id,
          class: d.class,
          present_in_reviewer_output: false,
          diagnosis: 'no-result',
        })
      }
      continue
    }

    const result = JSON.parse(readFileSync(resultPath, 'utf8'))
    const published: Finding[] = (result.findings ?? []).filter((f: Finding) => f.published)

    // --- recall
    const consumed = new Set<number>()
    for (const d of truth.defects) {
      const idx = published.findIndex((f, i) => !consumed.has(i) && matches(f, d, tol))
      if (idx >= 0) {
        consumed.add(idx)
        defectsFound++
        perClass[d.class].found++
        if (SEV_RANK[d.min_severity] >= SEV_RANK.P1) defectsP1Found++
        const got = published[idx].severity
        if (got === d.min_severity) sev.exact++
        else if (SEV_RANK[got] > SEV_RANK[d.min_severity]) sev.over++
        else sev.under++
      } else {
        misses.push({
          case_id: caseId,
          defect_id: d.defect_id,
          class: d.class,
          present_in_reviewer_output: reviewerMentioned(runDir, caseId, d),
          diagnosis: reviewerMentioned(runDir, caseId, d) ? 'adjudication' : 'discovery',
        })
      }
    }

    // --- precision. P3 on clean code is chattiness, not error (scoring.md §3.3).
    if (truth.kind === 'clean') {
      const material = published.filter((f) => SEV_RANK[f.severity] >= SEV_RANK.P2)
      if (material.length > 0) cleanCasesWithFinding++
      cleanCaseFindings += published.length
    }
    // Decoy attribution runs over findings NOT already credited to a real
    // defect. Decoys are deliberately placed adjacent to real defects — that
    // adjacency is the test — so a proximity check over all findings charges a
    // candidate for correctly finding the defect next door. Measured on this
    // corpus, 6 of 10 decoys sit inside the tolerance window of a real defect,
    // which made the old metric a measure of adjacency rather than of error.
    const unmatched = published.filter((_, i) => !consumed.has(i))
    for (const k of truth.decoys) {
      if (unmatched.some((f) => nearDecoy(f, k, tol))) decoysHit++
    }

    // --- routing
    const routing = result.routing ?? {}
    if (routing.tier === truth.expected_tier) tierOk++
    if (
      JSON.stringify([...(routing.overrides_fired ?? [])].sort()) ===
      JSON.stringify([...truth.expected_overrides].sort())
    ) {
      overrideOk++
    }
    const declared: string[] = routing.council_declared ?? []
    if (truth.expected_council_includes.every((p) => declared.includes(p))) councilOk++

    // --- coverage honesty
    if (truth.inject_failure && result.coverage?.complete === false) honestyOk++

    // --- anchors
    for (const f of published) {
      for (const e of f.evidence) {
        publishedAnchors++
        if (e.anchor_status === 'current_diff') currentDiffAnchors++
        if (e.anchor_status === 'unanchorable') unanchorable++
      }
    }

    // --- budget
    costs.push(result.telemetry?.cost_usd ?? 0)
    walls.push((result.telemetry?.duration_ms ?? rec.wall_ms) / 1000)
    // Reviewer completion, EXCLUDING deliberately injected failures.
    //
    // The harness tells the candidate to fail a named reviewer on some cases.
    // Counting that against the completion gate would zero a candidate for
    // honoring the injection correctly — punishing precisely the behaviour the
    // coverage-honesty axis rewards. Injected personas leave both sides of the
    // ratio; any OTHER failure still counts, which is what the gate is for.
    const injected = truth.inject_failure ? [truth.inject_failure.persona_id] : []
    const dec = (result.coverage?.declared ?? []).filter((p: string) => !injected.includes(p))
    const ret = (result.coverage?.returned ?? []).filter((p: string) => !injected.includes(p))
    if (dec.length > 0) {
      const ratio = ret.length / dec.length
      if (ratio < completionMin) {
        completionMin = ratio
        completionWorstCase = caseId
      }
    }
    for (const f of result.coverage?.failed ?? []) {
      if (!injected.includes(f.persona_id)) {
        unexpectedFailures.push(`${caseId}: ${f.persona_id} — ${f.reason}`)
      }
    }
  }

  const gates = {
    cost: quantile(costs, 0.95) <= COST_CAP_USD ? 'pass' : 'fail',
    latency: quantile(walls, 0.95) <= WALL_CAP_S ? 'pass' : 'fail',
    completion: completionMin >= COMPLETION_THRESHOLD ? 'pass' : 'fail',
    honesty: honestyTotal === 0 || honestyOk === honestyTotal ? 'pass' : 'fail',
    results_present: missingResults === 0 ? 'pass' : 'fail',
  }
  const gatesPass = Object.values(gates).every((g) => g === 'pass')

  const perClassRecall: Record<string, number> = {}
  for (const [c, v] of Object.entries(perClass)) perClassRecall[c] = pct(v.found, v.total)
  const classesWithData = Object.values(perClass).filter((v) => v.total > 0)
  const meanPerClass =
    classesWithData.reduce((a, v) => a + v.found / v.total, 0) / (classesWithData.length || 1)

  // Seen vs unseen. A class is SEEN when the labeled public set teaches it.
  // Unseen recall is the generalization signal: it measures whether the system
  // works from the specification or pattern-matches the examples it was handed.
  const agg = (classes: string[]) => {
    const rows = classes.map((c) => perClass[c]).filter((v) => v && v.total > 0)
    const found = rows.reduce((a, v) => a + v.found, 0)
    const total = rows.reduce((a, v) => a + v.total, 0)
    return { found, total, recall: pct(found, total), classes: rows.length }
  }
  const seen = agg(SEEN_CLASSES)
  const unseen = agg(UNSEEN_CLASSES)
  const generalizationGap =
    Number.isNaN(seen.recall) || Number.isNaN(unseen.recall)
      ? Number.NaN
      : Number((seen.recall - unseen.recall).toFixed(4))

  const recallP1 = pct(defectsP1Found, defectsP1Total)
  const cleanFp = pct(cleanCasesWithFinding, cleanCases)
  const decoyHit = pct(decoysHit, decoysTotal)
  const matched = sev.exact + sev.over + sev.under
  const anchorQuality = pct(currentDiffAnchors, publishedAnchors)
  const routingAcc = pct(tierOk + overrideOk + councilOk, routedCases * 3)

  // Unseen recall carries its own weight. A candidate that scores well only on
  // the classes it was shown has demonstrated example-fitting, not capability,
  // and an aggregate that blends the two hides exactly that.
  const composite = gatesPass
    ? Number(
        (
          3.0 * (recallP1 || 0) +
          2.0 * (Number.isNaN(unseen.recall) ? 0 : unseen.recall) +
          1.0 * meanPerClass +
          2.0 * (1 - (cleanFp || 0)) +
          // decoy_hit_rate is NOT scored — see `decoy_hit_rate_advisory`.
          1.0 * (Number.isNaN(anchorQuality) ? 0 : anchorQuality) +
          1.0 * pct(sev.exact, matched) +
          1.0 * routingAcc
        ).toFixed(3),
      )
    : 0

  const report = {
    run_tag: tag,
    split,
    final: process.argv.includes('--final'),
    candidate_identity: manifest.candidate_identity,
    holdout_override: manifest.holdout_override ?? false,
    corpus_version: manifest.corpus_manifest?.corpus_version ?? null,
    k: manifest.k,
    tolerance: tol,
    mechanism_matching: false,
    matching_note:
      'Structural matching only (path + category + line proximity). This OVERSTATES recall; a mechanism-matched pass understates it. Bracket the truth with both.',
    gates,
    per_class_recall: perClassRecall,
    mean_per_class_recall: Number(meanPerClass.toFixed(4)),
    seen_classes: SEEN_CLASSES,
    unseen_classes: UNSEEN_CLASSES,
    recall_seen: seen.recall,
    recall_unseen: unseen.recall,
    generalization_gap: generalizationGap,
    recall_p1: recallP1,
    recall_all: pct(defectsFound, defectsTotal),
    clean_case_fp_rate: cleanFp,
    // ADVISORY ONLY — not in the composite. Structural proximity cannot tell
    // "flagged the decoy" from "found a different real defect nearby", and in a
    // realistic fixture there is always something real nearby. Observed on this
    // corpus: a candidate was charged decoy hits for correctly reporting fake
    // crypto and a key-prefix leak that sat within tolerance of a decoy and were
    // never seeded at all. Requires manual adjudication to interpret.
    decoy_hit_rate_advisory: decoyHit,
    noise_ratio: pct(cleanCaseFindings, cleanCases),
    severity: {
      exact: pct(sev.exact, matched),
      over: pct(sev.over, matched),
      under: pct(sev.under, matched),
    },
    routing: {
      tier: pct(tierOk, routedCases),
      override: pct(overrideOk, routedCases),
      council: pct(councilOk, routedCases),
    },
    coverage_honesty: honestyTotal === 0 ? null : pct(honestyOk, honestyTotal),
    anchor_quality: anchorQuality,
    unanchorable_count: unanchorable,
    missing_results: missingResults,
    completion_min: Number(completionMin.toFixed(4)),
    completion_worst_case: completionWorstCase,
    unexpected_reviewer_failures: unexpectedFailures,
    cost_usd: { p50: quantile(costs, 0.5), p95: quantile(costs, 0.95), max: Math.max(0, ...costs) },
    latency_s: { p50: quantile(walls, 0.5), p95: quantile(walls, 0.95), max: Math.max(0, ...walls) },
    composite,
    misses,
  }

  const outPath = join(runDir, 'score.json')
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)

  // --- console summary. Per-class first, always.
  console.log(`\n${split} split — ${tag}${report.final ? '  [FINAL]' : ''}`)
  if (manifest.holdout_override) console.log('  !! holdout override was used; this result is not a clean holdout')
  const printGroup = (label: string, classes: string[]) => {
    console.log(`\n${label}:`)
    for (const c of classes) {
      const v = perClass[c]
      if (!v) continue
      const r = perClassRecall[c]
      console.log(
        `  ${c.padEnd(26)} ${v.total === 0 ? '   —  (no cases)' : `${(r * 100).toFixed(0).padStart(4)}%  (${v.found}/${v.total})`}`,
      )
    }
  }
  printGroup('SEEN classes (taught by the public set)', SEEN_CLASSES)
  printGroup('UNSEEN classes (generalization signal)', UNSEEN_CLASSES)
  console.log(
    `\n  recall seen ${fmt(seen.recall)}   unseen ${fmt(unseen.recall)}   gap ${Number.isNaN(generalizationGap) ? ' n/a' : `${(generalizationGap * 100).toFixed(0)}pp`}`,
  )
  console.log(`\naggregate:`)
  console.log(`  recall (P1+)        ${fmt(recallP1)}   mean per-class ${fmt(meanPerClass)}`)
  console.log(`  recall (all)        ${fmt(report.recall_all)}`)
  console.log(`  clean-case FP rate  ${fmt(cleanFp)}`)
  console.log(`  decoy hit (ADVISORY, unscored, needs manual review)  ${fmt(decoyHit)}`)
  console.log(`  severity exact      ${fmt(report.severity.exact)}   under ${fmt(report.severity.under)}`)
  console.log(`  routing tier/ovr/council ${fmt(report.routing.tier)} / ${fmt(report.routing.override)} / ${fmt(report.routing.council)}`)
  console.log(`  anchor quality      ${fmt(anchorQuality)}   unanchorable ${unanchorable}`)
  console.log(`  coverage honesty    ${report.coverage_honesty === null ? 'n/a' : fmt(report.coverage_honesty)}`)
  console.log(`  cost p50/p95        $${report.cost_usd.p50.toFixed(2)} / $${report.cost_usd.p95.toFixed(2)}`)
  console.log(`  latency p50/p95     ${report.latency_s.p50.toFixed(0)}s / ${report.latency_s.p95.toFixed(0)}s`)
  if (unexpectedFailures.length) {
    console.log(`\nreviewer failures beyond the injected ones (${unexpectedFailures.length}):`)
    for (const f of unexpectedFailures) console.log(`  - ${f}`)
  }
  console.log(
    `\ngates: ${Object.entries(gates).map(([k, v]) => `${k}=${v}`).join('  ')}` +
      (gates.completion === 'fail' ? `  (worst: ${completionWorstCase} at ${(completionMin * 100).toFixed(0)}%)` : ''),
  )
  console.log(`composite: ${composite} / 12.0${gatesPass ? '' : '  (zeroed by gate failure)'}`)
  console.log(`\nwrote ${outPath}`)
  const disc = (misses as { diagnosis: string }[]).filter((m) => m.diagnosis === 'discovery').length
  const adj = (misses as { diagnosis: string }[]).filter((m) => m.diagnosis === 'adjudication').length
  if (misses.length) console.log(`misses: ${misses.length} (${disc} discovery, ${adj} adjudication)`)
}

function fmt(n: number): string {
  return Number.isNaN(n) ? '  n/a' : `${(n * 100).toFixed(0).padStart(4)}%`
}

/**
 * Did any reviewer's retained raw output cite the defect location? This is the
 * field that decides which fix to attempt: a finding a reviewer emitted but the
 * result lacks was dropped in adjudication; one no reviewer emitted is a
 * discovery gap. The two have opposite fixes.
 */
function reviewerMentioned(runDir: string, caseId: string, d: Truth['defects'][number]): boolean {
  const dir = join(runDir, caseId, 'artifacts')
  if (!existsSync(dir)) return false
  let blob = ''
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name)
      if (e.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(json|txt|md|jsonl)$/.test(e.name)) continue
      try {
        blob += readFileSync(full, 'utf8')
      } catch {
        /* skip */
      }
    }
  }
  walk(dir)
  if (!blob.includes(d.path)) return false
  if (d.outside_diff) return true
  // Any line number within tolerance of the defect, appearing anywhere in the
  // retained reviewer output alongside the path.
  for (let l = d.line_start - DEFAULT_TOLERANCE; l <= d.line_end + DEFAULT_TOLERANCE; l++) {
    if (l > 0 && new RegExp(`\\b${l}\\b`).test(blob)) return true
  }
  return false
}

main()
