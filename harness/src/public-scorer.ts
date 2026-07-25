#!/usr/bin/env bun
// Public-set scorer — SHIPPED TO THE IMPLEMENTER.
//
// Self-contained on purpose: it imports nothing from the harness, so it can be
// copied into a workspace without dragging the corpus taxonomy along with it.
// Every class name it reports is read out of the truth files it is pointed at.
// A hardcoded list here would re-leak exactly what the split design exists to
// withhold.
//
// It reports the same axes as the real scorer, over the labeled public cases
// only. Numbers from it are directly comparable to the blind-set numbers you
// will be measured on — with one caveat stated in the output, and worth taking
// seriously: these are the cases you were given. Tuning until this reads 100%
// is how you overfit.
//
// Usage:
//   bun score-public.ts --cases <dir> --results <dir>
//
//   <dir>/<case-id>/truth.json           (shipped)
//   <results>/<case-id>/result.json      (produced by your `review` command)

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TOLERANCE = 12
const SEV_RANK: Record<string, number> = { P3: 0, P2: 1, P1: 2, P0: 3 }

function arg(flag: string, dflt?: string) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : dflt
}

function pct(n: number, d: number) {
  return d === 0 ? Number.NaN : n / d
}

function fmt(n: number) {
  return Number.isNaN(n) ? '  n/a' : `${(n * 100).toFixed(0).padStart(4)}%`
}

type Anchor = { path: string; line: number | null; anchor_status?: string }
type Finding = {
  severity: string
  category: string
  published: boolean
  evidence: Anchor[]
}
type Defect = {
  defect_id: string
  class: string
  path: string
  line_start: number
  line_end: number
  outside_diff: boolean
  min_severity: string
  expected_category: string[]
  mechanism: string
}

function matches(f: Finding, d: Defect): boolean {
  for (const e of f.evidence ?? []) {
    if (e.path !== d.path) continue
    if (!d.expected_category.includes(f.category)) continue
    if (d.outside_diff) return true
    if (e.line == null) continue
    if (e.line >= d.line_start - TOLERANCE && e.line <= d.line_end + TOLERANCE) return true
  }
  return false
}

function main() {
  const cases = resolve(arg('--cases', 'examples')!)
  const results = resolve(arg('--results', 'results')!)
  if (!existsSync(cases)) {
    console.error(`no such cases dir: ${cases}`)
    process.exit(2)
  }

  const perClass: Record<string, { found: number; total: number }> = {}
  let dTotal = 0
  let dFound = 0
  let p1Total = 0
  let p1Found = 0
  let cleanCases = 0
  let cleanFlagged = 0
  let decoyTotal = 0
  let decoyHit = 0
  const sev = { exact: 0, over: 0, under: 0 }
  let tierOk = 0
  let ovrOk = 0
  let councilOk = 0
  let routed = 0
  let honestyTotal = 0
  let honestyOk = 0
  let anchors = 0
  let anchorsCurrent = 0
  let missing = 0
  const misses: string[] = []

  const ids = readdirSync(cases, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()

  for (const id of ids) {
    const truthPath = join(cases, id, 'truth.json')
    if (!existsSync(truthPath)) continue
    const t = JSON.parse(readFileSync(truthPath, 'utf8'))
    const resPath = join(results, id, 'result.json')

    for (const d of t.defects as Defect[]) {
      dTotal++
      perClass[d.class] = perClass[d.class] ?? { found: 0, total: 0 }
      perClass[d.class].total++
      if (SEV_RANK[d.min_severity] >= SEV_RANK.P1) p1Total++
    }
    if (t.kind === 'clean') cleanCases++
    decoyTotal += (t.decoys ?? []).length
    if (t.inject_failure) honestyTotal++
    routed++

    if (!existsSync(resPath)) {
      missing++
      for (const d of t.defects as Defect[]) misses.push(`${id}/${d.defect_id} (${d.class}) — no result`)
      continue
    }

    const r = JSON.parse(readFileSync(resPath, 'utf8'))
    const pub: Finding[] = (r.findings ?? []).filter((f: Finding) => f.published)

    const used = new Set<number>()
    for (const d of t.defects as Defect[]) {
      const i = pub.findIndex((f, idx) => !used.has(idx) && matches(f, d))
      if (i >= 0) {
        used.add(i)
        dFound++
        perClass[d.class].found++
        if (SEV_RANK[d.min_severity] >= SEV_RANK.P1) p1Found++
        const got = pub[i].severity
        if (got === d.min_severity) sev.exact++
        else if (SEV_RANK[got] > SEV_RANK[d.min_severity]) sev.over++
        else sev.under++
      } else {
        misses.push(`${id}/${d.defect_id} (${d.class}) — ${d.mechanism.slice(0, 90)}…`)
      }
    }

    if (t.kind === 'clean' && pub.some((f) => SEV_RANK[f.severity] >= SEV_RANK.P2)) cleanFlagged++
    // Only findings NOT already credited to a real defect can count as decoy
    // hits. Decoys sit next to real defects on purpose; a plain proximity check
    // would charge you for correctly finding the defect beside them.
    const leftover = pub.filter((_, i) => !used.has(i))
    for (const k of t.decoys ?? []) {
      if (
        leftover.some((f) =>
          (f.evidence ?? []).some(
            (e) =>
              e.path === k.path &&
              e.line != null &&
              e.line >= k.line_start - TOLERANCE &&
              e.line <= k.line_end + TOLERANCE,
          ),
        )
      ) {
        decoyHit++
      }
    }

    const routing = r.routing ?? {}
    if (routing.tier === t.expected_tier) tierOk++
    if (
      JSON.stringify([...(routing.overrides_fired ?? [])].sort()) ===
      JSON.stringify([...t.expected_overrides].sort())
    ) {
      ovrOk++
    }
    if ((t.expected_council_includes ?? []).every((p: string) => (routing.council_declared ?? []).includes(p))) {
      councilOk++
    }
    if (t.inject_failure && r.coverage?.complete === false) honestyOk++
    for (const f of pub) {
      for (const e of f.evidence ?? []) {
        anchors++
        if (e.anchor_status === 'current_diff') anchorsCurrent++
      }
    }
  }

  console.log(`public set — ${ids.length} case(s), ${dTotal} seeded defect(s)\n`)
  console.log('per-class recall:')
  for (const c of Object.keys(perClass).sort()) {
    const v = perClass[c]
    console.log(`  ${c.padEnd(26)} ${fmt(pct(v.found, v.total))}  (${v.found}/${v.total})`)
  }
  console.log('')
  console.log(`  recall (P1+)        ${fmt(pct(p1Found, p1Total))}`)
  console.log(`  recall (all)        ${fmt(pct(dFound, dTotal))}`)
  console.log(`  clean-case FP rate  ${fmt(pct(cleanFlagged, cleanCases))}   decoy hit ${fmt(pct(decoyHit, decoyTotal))}`)
  const matched = sev.exact + sev.over + sev.under
  console.log(`  severity exact      ${fmt(pct(sev.exact, matched))}   under ${fmt(pct(sev.under, matched))}`)
  console.log(`  routing t/o/c       ${fmt(pct(tierOk, routed))} / ${fmt(pct(ovrOk, routed))} / ${fmt(pct(councilOk, routed))}`)
  console.log(`  anchor quality      ${fmt(pct(anchorsCurrent, anchors))}`)
  console.log(
    `  coverage honesty    ${honestyTotal === 0 ? 'n/a' : fmt(pct(honestyOk, honestyTotal))}${honestyTotal && honestyOk < honestyTotal ? '   <-- MUST be 100%' : ''}`,
  )
  if (missing) console.log(`  MISSING RESULTS     ${missing}`)

  if (misses.length) {
    console.log('\nmissed:')
    for (const m of misses) console.log(`  - ${m}`)
  }

  console.log(
    '\nNote: these are the cases you were given. You are measured on a blind set\n' +
      'that covers defect classes absent from this one. Tuning until this reads 100%\n' +
      'is overfitting, and the blind set is built to detect exactly that.',
  )
}

main()
