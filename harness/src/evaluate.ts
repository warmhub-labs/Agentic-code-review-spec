#!/usr/bin/env bun
// Run a candidate implementation across a corpus split.
//
// Enforces the holdout-is-spent-once rule (protocol/PROTOCOL.md, Phase 5):
// after a candidate identity has consumed the holdout, a second run requires an
// explicit override that is itself recorded in the report. Once information
// about the holdout has entered the loop, the holdout is development data.
//
// Usage:
//   bun src/evaluate.ts --candidate <path> --split dev --tag <tag> [--k 1]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listCaseDirs } from './corpus-fs.js'

type Args = {
  candidate: string
  split: 'dev' | 'holdout' | 'example'
  tag: string
  k: number
  corpus: string
  runs: string
  force: boolean
}

function parseArgs(): Args {
  const a = process.argv.slice(2)
  const get = (flag: string, dflt?: string) => {
    const i = a.indexOf(flag)
    return i >= 0 ? a[i + 1] : dflt
  }
  const candidate = get('--candidate')
  const tag = get('--tag')
  if (!candidate || !tag) {
    console.error('usage: evaluate.ts --candidate <path> --split <dev|holdout> --tag <tag> [--k 1]')
    process.exit(2)
  }
  return {
    candidate: resolve(candidate),
    split: (get('--split', 'dev') as Args['split']) ?? 'dev',
    tag,
    k: Number(get('--k', '1')),
    corpus: resolve(get('--corpus', join(import.meta.dir, '..', 'corpus'))!),
    runs: resolve(get('--runs', join(import.meta.dir, '..', 'runs'))!),
    force: a.includes('--force-holdout'),
  }
}

/**
 * Identity of the candidate = hash of its source tree. This is what the
 * holdout ledger is keyed on, so that "the same candidate" means the same
 * code, not the same path.
 */
function candidateIdentity(path: string): string {
  const h = createHash('sha256')
  const walk = (p: string) => {
    const st = statSync(p)
    if (st.isDirectory()) {
      for (const e of readdirSync(p).sort()) {
        // Skip build/vcs trees and every dot-entry. The dot-entry rule is
        // load-bearing: a stray .DS_Store would change the candidate identity,
        // which silently un-spends its holdout.
        if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue
        walk(join(p, e))
      }
    } else {
      h.update(p.split('/').pop() ?? '')
      h.update(readFileSync(p))
    }
  }
  walk(path)
  return h.digest('hex')
}

function holdoutLedgerPath(runs: string) {
  return join(runs, 'holdout-ledger.json')
}

function checkHoldout(args: Args, identity: string) {
  if (args.split !== 'holdout') return { overridden: false }
  const p = holdoutLedgerPath(args.runs)
  const ledger: Record<string, string[]> = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  const prior = ledger[identity] ?? []
  if (prior.length > 0 && !args.force) {
    console.error(
      `\nHOLDOUT ALREADY SPENT for this candidate identity.\n` +
        `  previous run(s): ${prior.join(', ')}\n\n` +
        `The holdout is run exactly once per candidate. After the first run, information\n` +
        `about it has entered the loop and it is development data. Revise the candidate\n` +
        `(which changes its identity) or use reserve cases.\n\n` +
        `To override anyway, pass --force-holdout. The override is recorded in the report.\n`,
    )
    process.exit(3)
  }
  ledger[identity] = [...prior, args.tag]
  mkdirSync(args.runs, { recursive: true })
  writeFileSync(p, `${JSON.stringify(ledger, null, 2)}\n`)
  return { overridden: prior.length > 0 }
}

function runCase(args: Args, caseDir: string, outDir: string, replicate: number) {
  const request = join(caseDir, 'review-request.json')
  const out = join(outDir, `result${replicate > 0 ? `.${replicate}` : ''}.json`)
  const artifacts = join(outDir, `artifacts${replicate > 0 ? `.${replicate}` : ''}`)
  mkdirSync(artifacts, { recursive: true })

  const started = Date.now()
  const proc = spawnSync(
    args.candidate,
    ['review', '--request', request, '--out', out, '--artifacts', artifacts],
    { encoding: 'utf8', timeout: 1_800_000 },
  )
  const wall = Date.now() - started

  return {
    exit_code: proc.status,
    timed_out: proc.error?.message?.includes('ETIMEDOUT') ?? false,
    wall_ms: wall,
    result_path: existsSync(out) ? out : null,
    stderr_tail: (proc.stderr ?? '').split('\n').slice(-20).join('\n'),
  }
}

function main() {
  const args = parseArgs()
  const splitDir = join(args.corpus, args.split)
  if (!existsSync(splitDir)) {
    console.error(`no such split: ${splitDir}`)
    process.exit(2)
  }

  const identity = candidateIdentity(args.candidate)
  const { overridden } = checkHoldout(args, identity)

  const outRoot = join(args.runs, args.tag)
  mkdirSync(outRoot, { recursive: true })

  const cases = listCaseDirs(splitDir)
  const records: unknown[] = []

  console.log(`candidate: ${args.candidate}`)
  console.log(`identity:  ${identity.slice(0, 16)}`)
  console.log(`split:     ${args.split} (${cases.length} cases, k=${args.k})\n`)

  for (const caseId of cases) {
    const caseDir = join(splitDir, caseId)
    for (let rep = 0; rep < args.k; rep++) {
      const outDir = join(outRoot, caseId)
      mkdirSync(outDir, { recursive: true })
      const r = runCase(args, caseDir, outDir, rep)
      records.push({ case_id: caseId, replicate: rep, ...r })
      const mark = r.result_path ? 'ok  ' : 'FAIL'
      console.log(`  ${mark} ${caseId.padEnd(40)} ${(r.wall_ms / 1000).toFixed(1)}s exit=${r.exit_code}`)
      if (!r.result_path && r.stderr_tail.trim()) {
        console.log(`       ${r.stderr_tail.split('\n').slice(-3).join('\n       ')}`)
      }
    }
  }

  writeFileSync(
    join(outRoot, 'run-manifest.json'),
    `${JSON.stringify(
      {
        tag: args.tag,
        split: args.split,
        k: args.k,
        candidate: args.candidate,
        candidate_identity: identity,
        corpus: args.corpus,
        corpus_manifest: existsSync(join(args.corpus, 'manifest.json'))
          ? JSON.parse(readFileSync(join(args.corpus, 'manifest.json'), 'utf8'))
          : null,
        holdout_override: overridden,
        records,
      },
      null,
      2,
    )}\n`,
  )

  const failed = records.filter((r) => !(r as { result_path: string | null }).result_path).length
  console.log(`\nwrote ${outRoot}`)
  if (failed) console.log(`${failed} case(s) produced no result — these score as total misses`)
  console.log(`next: bun src/score.ts --tag ${args.tag}`)
}

main()
