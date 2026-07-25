#!/usr/bin/env bun
// Null candidate — the score floor.
//
// Implements the CLI contract and the routing half of the specification, and
// nothing else: it dispatches no reviewers and finds no defects. Two uses:
//
//   1. Smoke-testing the harness. If evaluate + score do not run cleanly
//      against this, the problem is the harness, not the candidate.
//   2. A published floor. Any real candidate must beat it, and the shape of
//      its score shows what "found nothing, honestly" looks like: routing
//      accuracy near 1.0, recall 0, clean-case FP rate 0.
//
// Note what it does NOT do: report coverage.complete = true. It declared a
// council and returned none of it, so completeness is false. A null reviewer
// that claimed a complete clean review would violate the honesty gate — which
// is the point of scoring that separately from recall.
//
// Usage: bun src/null-candidate.ts review --request <f> --out <f> --artifacts <d>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { classifyDispatch } from './routing.js'

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main() {
  if (process.argv[2] !== 'review') {
    console.error('usage: null-candidate.ts review --request <f> --out <f> --artifacts <d>')
    process.exit(2)
  }
  const requestPath = arg('--request')
  const outPath = arg('--out')
  const artifacts = arg('--artifacts')
  if (!requestPath || !outPath || !artifacts) process.exit(2)

  const started = Date.now()
  const request = JSON.parse(readFileSync(requestPath, 'utf8'))
  const changed: string[] = request.diff.changed_files.map((f: { path: string }) => f.path)
  const plan = classifyDispatch(changed, request.policy)

  const digest = createHash('sha256')
    .update(request.diff.unified)
    .update(JSON.stringify(changed))
    .update(JSON.stringify(request.policy))
    .digest('hex')

  const result = {
    schema_version: '1.0.0',
    run_id: request.run.run_id,
    change_id: request.change.id,
    head_sha: request.change.head_sha,
    outcome: 'engaged',
    turn_state: 'INITIAL',
    routing: {
      tier: plan.tier,
      static_floor: plan.tier,
      matched_rules: plan.matchedRules,
      overrides_fired: plan.overrides,
      council_declared: plan.council,
      packet_digest: digest,
    },
    coverage: {
      declared: plan.council,
      returned: [],
      failed: plan.council.map((p) => ({ persona_id: p, reason: 'null candidate dispatches no reviewers' })),
      // Honest: no coordinator ran, so completeness is false unconditionally —
      // even on a case where routing legitimately declared an empty council.
      complete: false,
      coordinator_ran: false,
      coordinator_source: 'synthesis',
      deadline_exceeded: false,
      publication_truncated: false,
    },
    overall_rating: 'CLEAN',
    blocking: false,
    halt: { should_halt: true, reason: 'no findings' },
    findings: [],
    suppressed_count: 0,
    audit_rows_dispositioned: 0,
    audit_rows_undischarged: (request.deterministic_audit?.rows ?? []).length,
    reviewer_summaries: [],
    telemetry: {
      duration_ms: Date.now() - started,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      per_persona: plan.council.map((p) => ({
        persona_id: p,
        duration_ms: 0,
        cost_usd: 0,
        status: 'failed' as const,
      })),
    },
    errors: [],
  }

  mkdirSync(artifacts, { recursive: true })
  writeFileSync(
    join(artifacts, 'personas.json'),
    `${JSON.stringify({ run_id: request.run.run_id, packet_digest: digest, personas: [], coordinator_raw_output: null }, null, 2)}\n`,
  )
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`)
}

main()
