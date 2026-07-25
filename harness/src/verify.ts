#!/usr/bin/env bun
// Corpus self-test — Phase 0 of the protocol.
//
// A corpus that has not been self-tested is not evidence. Every candidate is
// graded against these files, so an error here becomes a systematic error in
// every result that follows.
//
// Checks:
//   1. Every case has a ReviewRequest that validates structurally.
//   2. Every truth anchor resolves to a real line in the head tree.
//   3. Defects marked outside_diff really are outside every diff hunk, and
//      defects not so marked really are inside one.
//   4. Every mechanically-verifiable defect's verification command succeeds
//      against the head tree.
//   5. Every reasoned defect carries a written rationale.
//   6. Clean cases seed no defects.
//   7. Splits are disjoint; ids are unique.
//   8. The corpus digest is reproducible.
//
// Usage: bun src/verify.ts [--corpus <dir>]

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listCaseDirs } from './corpus-fs.js'

type Problem = { case_id: string; check: string; detail: string }

const problems: Problem[] = []
const notes: string[] = []

function fail(case_id: string, check: string, detail: string) {
  problems.push({ case_id, check, detail })
}

/** Line numbers touched on the RIGHT side of a unified diff, per file. */
function hunkLinesByFile(unified: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  let path: string | null = null
  let line = 0
  for (const raw of unified.split('\n')) {
    const fileMatch = raw.match(/^\+\+\+ b\/(.+)$/)
    if (fileMatch) {
      path = fileMatch[1]
      if (!out.has(path)) out.set(path, new Set())
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!path) continue
    if (raw.startsWith('+')) {
      out.get(path)?.add(line)
      line++
    } else if (raw.startsWith('-')) {
      // Removed lines do not advance the right-side counter.
    } else if (raw.startsWith(' ')) {
      line++
    }
  }
  return out
}

function verifyCase(caseDir: string, seenIds: Set<string>) {
  const request = JSON.parse(readFileSync(join(caseDir, 'review-request.json'), 'utf8'))
  const truth = JSON.parse(readFileSync(join(caseDir, 'truth.json'), 'utf8'))
  const id: string = truth.case_id

  if (seenIds.has(id)) fail(id, 'unique-id', 'duplicate case id across splits')
  seenIds.add(id)

  // 1 — structural sanity on the request
  for (const k of ['change', 'workspace', 'diff', 'policy', 'run']) {
    if (!request[k]) fail(id, 'request-shape', `missing top-level "${k}"`)
  }
  if (!request.diff.unified || request.diff.changed_files.length === 0) {
    fail(id, 'request-shape', 'empty diff — a case with no change reviews nothing')
  }

  const repo = request.workspace.root as string
  if (!existsSync(repo)) {
    fail(id, 'workspace', `workspace root does not exist: ${repo}`)
    return
  }

  const hunks = hunkLinesByFile(request.diff.unified)

  // 6 — clean cases seed no defects
  if (truth.kind === 'clean' && truth.defects.length > 0) {
    fail(id, 'clean-case', `kind=clean but ${truth.defects.length} defect(s) seeded`)
  }
  if (truth.kind === 'defective' && truth.defects.length === 0) {
    fail(id, 'defective-case', 'kind=defective but no defects seeded')
  }

  for (const d of truth.defects) {
    const file = join(repo, d.path)

    // 2 — the anchor resolves to a real line
    if (!existsSync(file)) {
      fail(id, 'anchor-file', `${d.defect_id}: ${d.path} absent from the head tree`)
      continue
    }
    const lineCount = readFileSync(file, 'utf8').split('\n').length
    if (d.line_start < 1 || d.line_end > lineCount) {
      fail(
        id,
        'anchor-range',
        `${d.defect_id}: lines ${d.line_start}-${d.line_end} outside ${d.path} (${lineCount} lines)`,
      )
    }

    // 3 — outside_diff must be truthful in both directions
    const touched = hunks.get(d.path)
    const inHunk = !!touched && [...touched].some((l) => l >= d.line_start && l <= d.line_end)
    if (d.outside_diff && inHunk) {
      fail(id, 'outside-diff', `${d.defect_id}: marked outside_diff but lands inside a diff hunk`)
    }
    if (!d.outside_diff && !inHunk) {
      fail(
        id,
        'outside-diff',
        `${d.defect_id}: not marked outside_diff but lines ${d.line_start}-${d.line_end} of ${d.path} are not in any hunk`,
      )
    }

    // 4 / 5 — verification obligations
    if (d.verification === 'mechanical') {
      if (!d.verification_command) {
        fail(id, 'verification', `${d.defect_id}: mechanical but no verification_command`)
      } else {
        try {
          execSync(d.verification_command, { cwd: repo, stdio: 'pipe' })
        } catch {
          fail(
            id,
            'verification',
            `${d.defect_id}: verification_command failed against the head tree: ${d.verification_command}`,
          )
        }
      }
    } else if (!d.verification_note || d.verification_note.length < 20) {
      fail(
        id,
        'verification',
        `${d.defect_id}: reasoned defects require a written verification_note`,
      )
    }
  }

  for (const k of truth.decoys ?? []) {
    if (!existsSync(join(repo, k.path))) {
      fail(id, 'decoy-file', `${k.decoy_id}: ${k.path} absent from the head tree`)
    }
  }

  const reasoned = truth.defects.filter((d: { verification: string }) => d.verification === 'reasoned').length
  if (reasoned > 0) notes.push(`${id}: ${reasoned} reasoned (non-mechanical) defect(s)`)
}

function main() {
  const args = process.argv.slice(2)
  const ci = args.indexOf('--corpus')
  const corpus = resolve(ci >= 0 ? args[ci + 1] : join(import.meta.dir, '..', 'corpus'))

  if (!existsSync(corpus)) {
    console.error(`no corpus at ${corpus} — run: bun src/seed.ts`)
    process.exit(2)
  }

  const seenIds = new Set<string>()
  const splitCounts: Record<string, number> = {}
  const digest = createHash('sha256')

  for (const split of ['public', 'dev', 'blind']) {
    const dir = join(corpus, split)
    if (!existsSync(dir)) continue
    for (const id of listCaseDirs(dir)) {
      const caseDir = join(dir, id)
      verifyCase(caseDir, seenIds)
      splitCounts[split] = (splitCounts[split] ?? 0) + 1
      // 8 — digest over ground truth + request diff, not over the git objects
      // (which carry paths that differ per machine).
      digest.update(readFileSync(join(caseDir, 'truth.json')))
      digest.update(JSON.parse(readFileSync(join(caseDir, 'review-request.json'), 'utf8')).diff.unified)
    }
  }

  const total = Object.values(splitCounts).reduce((a, b) => a + b, 0)
  const reasonedTotal = notes.length

  console.log(`corpus:  ${corpus}`)
  console.log(`cases:   ${total} (${Object.entries(splitCounts).map(([k, v]) => `${k}=${v}`).join(', ')})`)
  console.log(`digest:  ${digest.digest('hex').slice(0, 16)}`)
  console.log(`reasoned-verification cases: ${reasonedTotal}`)

  if (problems.length === 0) {
    console.log('\nself-test PASSED')
    console.log('next: bun src/evaluate.ts --candidate <path> --split dev --tag <tag>')
    return
  }

  console.error(`\nself-test FAILED — ${problems.length} problem(s):\n`)
  for (const p of problems) console.error(`  [${p.case_id}] ${p.check}: ${p.detail}`)
  console.error('\nA corpus that fails self-test is not evidence. Fix it before evaluating.')
  process.exit(1)
}

main()
