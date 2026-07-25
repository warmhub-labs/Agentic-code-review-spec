#!/usr/bin/env bun
// Build the implementer's workspace — Phase 1 of the protocol.
//
// Blinding is enforced by CONSTRUCTION, not by instruction. An agent told not to
// look at ground truth, but able to, will find it and optimize against it — and
// the experiment then measures nothing.
//
// What ships:
//   spec/            the specification
//   schema/          the four WIRE CONTRACTS, by explicit allowlist
//   public/          the labeled cases: request + repo + truth + worked result
//   score-public.ts  a scorer over the public cases only
//   ENVIRONMENT.md   a neutral inventory of the machine
//   README.md        the implementer brief
//
// What must never ship: any case from a hidden split, any ground truth for one,
// and any file that names a defect class the public set does not already teach.
//
// The forbidden-token list is DERIVED from the hidden corpus at build time, not
// hand-maintained. A hand-list goes stale the moment a case is added, and it
// goes stale silently.
//
// Usage: bun src/make-workspace.ts --out <dir> [--force]

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listCaseDirs } from './corpus-fs.js'

const WIRE_CONTRACTS = [
  'review-request.schema.json',
  'review-result.schema.json',
  'specialist-output.schema.json',
  'coordinator-output.schema.json',
]

const HIDDEN_SPLITS = ['dev', 'blind']

function arg(flag: string, dflt?: string) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : dflt
}

/**
 * Everything the workspace must not contain, read out of the hidden corpus.
 *
 * Three sources: hidden case ids, defect classes that appear ONLY in hidden
 * splits, and decoy rationales (which describe hidden mechanisms in prose).
 */
function deriveForbidden(corpus: string) {
  const hiddenIds = new Set<string>()
  const hiddenClasses = new Set<string>()
  const publicClasses = new Set<string>()
  const prose = new Set<string>()

  const scan = (split: string, hidden: boolean) => {
    const dir = join(corpus, split)
    if (!existsSync(dir)) return
    for (const id of listCaseDirs(dir)) {
      const t = JSON.parse(readFileSync(join(dir, id, 'truth.json'), 'utf8'))
      if (hidden) hiddenIds.add(id)
      for (const d of t.defects ?? []) {
        ;(hidden ? hiddenClasses : publicClasses).add(d.class)
        if (hidden) prose.add(d.mechanism.slice(0, 60))
      }
      if (hidden) for (const k of t.decoys ?? []) prose.add(k.why_not_a_defect.slice(0, 60))
    }
  }
  scan('public', false)
  for (const s of HIDDEN_SPLITS) scan(s, true)

  // A class taught by the public set is not a secret. Only classes exclusive to
  // hidden splits are.
  const unseen = [...hiddenClasses].filter((c) => !publicClasses.has(c))
  return { tokens: [...hiddenIds, ...unseen, ...prose], unseen, hiddenIds: [...hiddenIds] }
}

function main() {
  const out = resolve(arg('--out') ?? '')
  if (!out) {
    console.error('usage: make-workspace.ts --out <dir> [--force]')
    process.exit(2)
  }
  if (existsSync(out) && !process.argv.includes('--force')) {
    console.error(`${out} exists — pass --force to replace`)
    process.exit(2)
  }

  const bundle = resolve(join(import.meta.dir, '..', '..'))
  const harness = resolve(join(import.meta.dir, '..'))
  const corpus = join(harness, 'corpus')
  const publicDir = join(corpus, 'public')

  if (!existsSync(publicDir)) {
    console.error('no public split — run: bun src/seed.ts --force')
    process.exit(2)
  }

  const forbidden = deriveForbidden(corpus)

  rmSync(out, { recursive: true, force: true })
  mkdirSync(join(out, 'public'), { recursive: true })
  mkdirSync(join(out, 'schema'), { recursive: true })

  cpSync(join(bundle, 'spec'), join(out, 'spec'), { recursive: true })
  for (const f of WIRE_CONTRACTS) cpSync(join(harness, 'schema', f), join(out, 'schema', f))
  writeFileSync(join(out, 'README.md'), readFileSync(join(bundle, 'protocol', 'implementer-brief.md')))
  writeFileSync(join(out, 'ENVIRONMENT.md'), readFileSync(join(bundle, 'protocol', 'ENVIRONMENT.md')))
  writeFileSync(join(out, 'score-public.ts'), readFileSync(join(harness, 'src', 'public-scorer.ts')))

  const copied: string[] = []
  let worked = 0
  for (const id of listCaseDirs(publicDir)) {
    const src = join(publicDir, id)
    const dst = join(out, 'public', id)
    mkdirSync(dst, { recursive: true })
    cpSync(join(src, 'review-request.json'), join(dst, 'review-request.json'))
    cpSync(join(src, 'truth.json'), join(dst, 'truth.json'))
    cpSync(join(src, 'repo'), join(dst, 'repo'), { recursive: true })
    if (existsSync(join(src, 'review-result.json'))) {
      cpSync(join(src, 'review-result.json'), join(dst, 'review-result.json'))
      worked++
    }
    copied.push(id)
  }

  // --- leak audit, by content and by filename, over everything shipped.
  const leaks: string[] = []
  const publicCaseRoot = join(out, 'public')
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (e.name === 'manifest.json' || e.name === 'score.json' || e.name === 'truth.schema.json') {
        leaks.push(`${p} (forbidden filename)`)
        continue
      }
      // Public truth files are shipped deliberately; everything else is scanned.
      const isPublicTruth = e.name === 'truth.json' && p.startsWith(publicCaseRoot)
      if (isPublicTruth) continue
      if (!/\.(json|md|ts|txt|ya?ml)$/.test(e.name)) continue
      const body = readFileSync(p, 'utf8')
      for (const token of forbidden.tokens) {
        if (token.length >= 8 && body.includes(token)) {
          leaks.push(`${p} (mentions hidden corpus: "${token.slice(0, 40)}…")`)
        }
      }
    }
  }
  walk(out)

  if (leaks.length) {
    console.error(`workspace leaks hidden-corpus content:\n  ${leaks.join('\n  ')}`)
    process.exit(1)
  }

  console.log(`workspace: ${out}`)
  console.log(`  spec/            ${readdirSync(join(out, 'spec')).length} parts`)
  console.log(`  schema/          ${WIRE_CONTRACTS.length} wire contracts (allowlisted)`)
  console.log(`  public/          ${copied.length} labeled cases, ${worked} with a worked result`)
  console.log(`  score-public.ts  self-scorer over the public cases`)
  console.log(`  ENVIRONMENT.md   neutral machine inventory`)
  console.log(`  README.md        implementer brief`)
  console.log(`\nwithheld: ${forbidden.hiddenIds.length} hidden cases`)
  console.log(`withheld classes (the generalization test): ${forbidden.unseen.length}`)
  console.log('leak audit: clean (filename + content, tokens derived from the hidden corpus)')
}

main()
