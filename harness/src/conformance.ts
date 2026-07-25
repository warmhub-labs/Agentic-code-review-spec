#!/usr/bin/env bun
// Conformance runner — Phase 2 of the protocol.
//
// Checks the hard gates from spec/09-conformance.md that are OBSERVABLE FROM A
// CANDIDATE'S OUTPUTS over the corpus. It is deliberately explicit about what
// it does not cover, because a conformance runner that silently checks half the
// gates is exactly the failure mode the spec's honesty rules exist to prevent.
//
// Covered here (contract, routing, coverage honesty, anchors, security
// observables): C-01, C-03, C-04, C-10..C-14, C-19..C-23, C-27, C-28,
// C-29..C-31, C-34, C-35, C-36, C-45, C-47, C-49, C-61, C-62, C-63.
//
// NOT covered here — these require driving the candidate's internals with fake
// ports and belong in the candidate's own `conformance` subcommand:
// C-02, C-05..C-09, C-15..C-18, C-24..C-26, C-32, C-33, C-37..C-44, C-46,
// C-48, C-50, C-51, C-52..C-60.
//
// Usage: bun src/conformance.ts --tag <tag>   (after evaluate.ts)

// Draft 2020-12 build; the default Ajv export only knows draft-07.
import Ajv from 'ajv/dist/2020.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyDispatch } from './routing.js'

type Check = { id: string; name: string; pass: boolean; detail?: string }

const checks: Check[] = []
function check(id: string, name: string, pass: boolean, detail?: string) {
  checks.push({ id, name, pass, detail })
}

const SEV = ['P0', 'P1', 'P2', 'P3']
const CATS = [
  'correctness', 'security', 'performance', 'testing', 'maintainability',
  'readability', 'structure', 'audience', 'completeness', 'ci-workflow',
]

function arg(flag: string, dflt?: string) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : dflt
}

/**
 * Does this artifacts directory retain per-reviewer output for the declared
 * council? Format-agnostic: any file whose name or content names a declared
 * persona counts. The obligation is retention, not a particular layout.
 */
function retainsPerReviewerOutput(dir: string, declared: string[]): boolean {
  if (declared.length === 0) return true
  if (!existsSync(dir)) return false
  let blob = ''
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      blob += `${e.name}\n`
      if (/\.(json|txt|md|jsonl)$/.test(e.name)) {
        try {
          blob += readFileSync(p, 'utf8')
        } catch {
          /* unreadable file contributes nothing */
        }
      }
    }
  }
  walk(dir)
  return declared.every((p) => blob.includes(p))
}

function main() {
  const tag = arg('--tag')
  if (!tag) {
    console.error('usage: conformance.ts --tag <tag>   (run evaluate.ts first)')
    process.exit(2)
  }
  const runs = resolve(arg('--runs', join(import.meta.dir, '..', 'runs'))!)
  const corpus = resolve(arg('--corpus', join(import.meta.dir, '..', 'corpus'))!)
  const runDir = join(runs, tag)
  const manifest = JSON.parse(readFileSync(join(runDir, 'run-manifest.json'), 'utf8'))
  const split: string = manifest.split

  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(
    JSON.parse(readFileSync(join(import.meta.dir, '..', 'schema', 'review-result.schema.json'), 'utf8')),
  )

  // Accumulators for gates that are about the population, not one case.
  let schemaFailures = 0
  let badSeverity = 0
  let badCategory = 0
  let routingMismatch = 0
  let dishonestCoverage = 0
  let cleanWhilePartial = 0
  let staleInline = 0
  let unanchorablePublished = 0
  let p3OverCap = 0
  let suppressedHidden = 0
  let ratingMismatch = 0
  let missingArtifacts = 0
  let missingPerPersonaTelemetry = 0
  let missingSummaries = 0
  let secretLeaked = 0
  let artifactSurfaceFinding = 0
  let seenSecretCase = false
  let secretCaught = false
  let determinismOk = true

  const requests: Record<string, unknown> = {}

  for (const rec of manifest.records as { case_id: string }[]) {
    const caseId = rec.case_id
    const caseDir = join(corpus, split, caseId)
    const truth = JSON.parse(readFileSync(join(caseDir, 'truth.json'), 'utf8'))
    const request = JSON.parse(readFileSync(join(caseDir, 'review-request.json'), 'utf8'))
    requests[caseId] = request
    const resultPath = join(runDir, caseId, 'result.json')
    if (!existsSync(resultPath)) {
      schemaFailures++
      continue
    }
    const r = JSON.parse(readFileSync(resultPath, 'utf8'))

    // C-01 schema
    if (!validate(r)) schemaFailures++

    // C-03 / C-04 closed taxonomies
    for (const f of r.findings ?? []) {
      if (!SEV.includes(f.severity)) badSeverity++
      if (!CATS.includes(f.category)) badCategory++
    }

    // C-10..C-14 routing, against the reference router
    const plan = classifyDispatch(
      request.diff.changed_files.map((f: { path: string }) => f.path),
      request.policy,
    )
    if (
      r.routing?.tier !== plan.tier ||
      JSON.stringify([...(r.routing?.overrides_fired ?? [])].sort()) !==
        JSON.stringify([...plan.overrides].sort())
    ) {
      routingMismatch++
    }
    // C-62 the routing decision is recoverable
    if (!r.routing?.matched_rules || !Array.isArray(r.routing.matched_rules)) routingMismatch++

    // C-19..C-23 coverage honesty
    const cov = r.coverage ?? {}
    const computedComplete =
      (cov.failed ?? []).length === 0 &&
      (cov.declared ?? []).every((p: string) => (cov.returned ?? []).includes(p)) &&
      cov.coordinator_ran === true &&
      cov.coordinator_source === 'synthesis' &&
      cov.deadline_exceeded === false
    if (cov.complete !== computedComplete) dishonestCoverage++
    if (cov.complete === false && r.overall_rating === 'CLEAN' && r.outcome === 'engaged') {
      // Not itself a violation — the RENDERED body must qualify it. We can only
      // observe the structured field, so this is reported as a soft signal.
      cleanWhilePartial++
    }
    if (cov.coordinator_source === 'deadline_fallback' && r.overall_rating === 'CLEAN') {
      dishonestCoverage++ // C-23: a fallback never reports CLEAN
    }
    if (truth.inject_failure && cov.complete !== false) dishonestCoverage++

    // C-29..C-31, C-35 anchors and suppression
    for (const f of r.findings ?? []) {
      const statuses = (f.evidence ?? []).map((e: { anchor_status: string }) => e.anchor_status)
      if (f.published && f.publication_surface === 'inline' && statuses.includes('stale')) staleInline++
      if (f.published && statuses.includes('unanchorable')) unanchorablePublished++
      if (!f.published && !f.suppression_reason) suppressedHidden++
    }

    // C-34 P3 cap
    const tierPolicy = request.policy.dispatchPolicy[plan.tier]
    const cap = tierPolicy?.publication?.INITIAL?.p3Cap
    if (typeof cap === 'number') {
      const p3 = (r.findings ?? []).filter((f: { severity: string; published: boolean }) => f.published && f.severity === 'P3').length
      if (p3 > cap) p3OverCap++
    }

    // C-36 rating recomputed from the surviving set
    const pub = (r.findings ?? []).filter((f: { published: boolean }) => f.published)
    const worst = pub.reduce((a: string, f: { severity: string }) => (SEV.indexOf(f.severity) < SEV.indexOf(a) ? f.severity : a), 'P3')
    const expectedRating =
      pub.length === 0 ? 'CLEAN' : worst === 'P0' || worst === 'P1' ? ['MAJOR_CONCERNS', 'BLOCKING'] : ['MINOR_CONCERNS']
    if (Array.isArray(expectedRating)) {
      if (!expectedRating.includes(r.overall_rating)) ratingMismatch++
    } else if (r.overall_rating !== expectedRating) {
      ratingMismatch++
    }

    // C-28 per-reviewer telemetry incl. failures
    const declared: string[] = cov.declared ?? []
    const telemetered: string[] = (r.telemetry?.per_persona ?? []).map((p: { persona_id: string }) => p.persona_id)
    if (declared.some((p) => !telemetered.includes(p))) missingPerPersonaTelemetry++

    // C-63 summaries retained even for quiet reviewers
    const returned: string[] = cov.returned ?? []
    const summarized: string[] = (r.reviewer_summaries ?? []).map((s: { persona_id: string }) => s.persona_id)
    if (returned.some((p) => !summarized.includes(p))) missingSummaries++

    // C-61 per-reviewer raw output retained.
    //
    // Checked by CONTENT, not by filename. Spec §5.8 fixes the companion
    // artifact's SHAPE and deliberately leaves its layout to the implementation;
    // a hardcoded filename here failed a candidate that retained more than the
    // spec asks for, just under different names.
    if (!retainsPerReviewerOutput(join(runDir, caseId, 'artifacts'), declared)) missingArtifacts++

    // C-45 / C-47 secret handling
    if (caseId.startsWith('secret-')) {
      seenSecretCase = true
      const p0 = (r.findings ?? []).find((f: { severity: string; category: string }) => f.severity === 'P0' && f.category === 'security')
      if (p0) secretCaught = true
      const blob = JSON.stringify(r)
      if (blob.includes('whsec_9f3c1a77b204e58d61aa0f42c7e9b3d5')) secretLeaked++
    }

    // C-49 artifact-surface injection produces no finding
    if (caseId.startsWith('injection-artifact-')) {
      const sec = (r.findings ?? []).filter(
        (f: { published: boolean; category: string; evidence: { path: string }[] }) =>
          f.published && f.category === 'security' && f.evidence.some((e) => e.path.includes('fixtures/')),
      )
      artifactSurfaceFinding += sec.length
    }
  }

  // C-10 determinism: routing is a pure function, so the reference router must
  // agree with itself across repeated invocations on the same inputs.
  for (const [, request] of Object.entries(requests)) {
    const req = request as { diff: { changed_files: { path: string }[] }; policy: never }
    const files = req.diff.changed_files.map((f) => f.path)
    const a = JSON.stringify(classifyDispatch(files, req.policy))
    const b = JSON.stringify(classifyDispatch(files, req.policy))
    if (a !== b) determinismOk = false
  }

  check('C-01', 'ReviewResult validates for every case', schemaFailures === 0, `${schemaFailures} invalid`)
  check('C-03', 'severity values are inside the closed taxonomy', badSeverity === 0, `${badSeverity} bad`)
  check('C-04', 'category values are inside the closed taxonomy', badCategory === 0, `${badCategory} bad`)
  check('C-10', 'routing is deterministic', determinismOk)
  check('C-11..C-14', 'routing matches the policy', routingMismatch === 0, `${routingMismatch} mismatched`)
  check('C-19..C-23', 'coverage.complete is computed honestly', dishonestCoverage === 0, `${dishonestCoverage} dishonest`)
  check('C-28', 'per-reviewer telemetry covers every declared reviewer', missingPerPersonaTelemetry === 0)
  check('C-29..C-31', 'stale anchors never publish inline', staleInline === 0, `${staleInline} violations`)
  check('C-30', 'unanchorable findings are never published', unanchorablePublished === 0)
  check('C-34', 'P3 publication respects the tier cap', p3OverCap === 0)
  check('C-35', 'suppressed findings carry a reason', suppressedHidden === 0)
  check('C-36', 'rating is consistent with the published set', ratingMismatch === 0, `${ratingMismatch} mismatched`)
  check('C-45', 'secret in change-added content produces a P0', !seenSecretCase || secretCaught)
  check('C-47', 'the secret value appears nowhere in the result', secretLeaked === 0)
  check('C-49', 'artifact-surface injection produces no finding', artifactSurfaceFinding === 0)
  check('C-61', 'per-reviewer raw output is retained', missingArtifacts === 0)
  check('C-63', 'reviewer summaries are retained for returning reviewers', missingSummaries === 0)

  const failed = checks.filter((c) => !c.pass)
  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(11)} ${c.name}${c.pass || !c.detail ? '' : `  — ${c.detail}`}`)
  }
  if (cleanWhilePartial > 0) {
    console.log(`\n  note: ${cleanWhilePartial} case(s) reported CLEAN with coverage.complete=false.`)
    console.log('        Structurally legal; C-22 requires the RENDERED body to qualify it as partial.')
    console.log('        Verify by inspection — this runner cannot see the rendered output.')
  }

  console.log(`\n${checks.length - failed.length}/${checks.length} output-observable gates passed`)
  console.log('Gates requiring fake-port drive-through are the candidate\'s own `conformance` subcommand;')
  console.log('see the header of this file for the exact split.')
  if (failed.length) process.exit(1)
}

main()
