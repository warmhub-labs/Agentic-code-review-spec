#!/usr/bin/env bun
// Corpus seeder.
//
// For every case in the library: materialize a real git repository with a base
// commit and a head commit, derive the diff from git rather than hand-writing
// it, resolve every truth anchor to a concrete line number in the head tree,
// and emit a ReviewRequest plus a ground-truth file.
//
// Anchors are content substrings, not line numbers. A template edit that moves
// a defect therefore fails loudly here instead of silently re-pointing the
// ground truth at the wrong line.
//
// Usage: bun src/seed.ts [--out <dir>] [--force]

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LIBRARY, type SeedCase, type SeedDefect } from './defects/index.js'
import { FIXTURE_FILES } from './fixture-project.js'
import { POLICY } from './policy.js'
import { classifyDispatch } from './routing.js'

const CORPUS_VERSION = '1.0.0'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'corpus',
      GIT_AUTHOR_EMAIL: 'corpus@example.invalid',
      GIT_COMMITTER_NAME: 'corpus',
      GIT_COMMITTER_EMAIL: 'corpus@example.invalid',
      // Fixed timestamps keep the corpus digest stable across regenerations.
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    },
  })
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
}

/**
 * Resolve an anchor substring to a 1-based line number in `content`.
 * Throws when the anchor is absent or ambiguous — both are corpus bugs, and
 * both must stop the seed rather than produce ground truth nobody can trust.
 */
function resolveAnchor(caseId: string, path: string, content: string, anchor: string): number {
  const idx = content.indexOf(anchor)
  if (idx === -1) {
    throw new Error(`[${caseId}] anchor not found in ${path}: ${JSON.stringify(anchor.slice(0, 60))}`)
  }
  if (content.indexOf(anchor, idx + 1) !== -1) {
    throw new Error(`[${caseId}] anchor is ambiguous in ${path}: ${JSON.stringify(anchor.slice(0, 60))}`)
  }
  return content.slice(0, idx).split('\n').length
}

function buildTrees(c: SeedCase): { base: Record<string, string>; head: Record<string, string> } {
  const base = { ...FIXTURE_FILES, ...(c.baseExtra ?? {}) }
  const head = { ...base, ...c.head }
  for (const del of c.headDeletes ?? []) delete head[del]
  return { base, head }
}

function changedFiles(repo: string, baseSha: string, headSha: string) {
  const raw = git(repo, 'diff', '--numstat', '--find-renames', `${baseSha}..${headSha}`).trim()
  if (!raw) return []
  return raw.split('\n').map((line) => {
    const [addRaw, delRaw, path] = line.split('\t')
    const binary = addRaw === '-' || delRaw === '-'
    return {
      path,
      status: statusOf(repo, baseSha, headSha, path),
      previous_path: null,
      additions: binary ? 0 : Number(addRaw),
      deletions: binary ? 0 : Number(delRaw),
      binary,
      generated: false,
    }
  })
}

function statusOf(repo: string, baseSha: string, headSha: string, path: string) {
  const code = git(repo, 'diff', '--name-status', `${baseSha}..${headSha}`, '--', path).trim().charAt(0)
  if (code === 'A') return 'added' as const
  if (code === 'D') return 'removed' as const
  if (code === 'R') return 'renamed' as const
  return 'modified' as const
}

function assertRouting(c: SeedCase, plan: { tier: string; overrides: string[]; council: string[] }) {
  const problems: string[] = []
  if (plan.tier !== c.expected_tier) {
    problems.push(`tier: declared ${c.expected_tier}, policy computes ${plan.tier}`)
  }
  const declared = [...c.expected_overrides].sort().join(',')
  const computed = [...plan.overrides].sort().join(',')
  if (declared !== computed) {
    problems.push(`overrides: declared [${declared}], policy computes [${computed}]`)
  }
  for (const p of c.expected_council_includes) {
    if (!plan.council.includes(p)) {
      problems.push(`council: expected ${p}, policy assembles [${plan.council.join(', ')}]`)
    }
  }
  if (problems.length) {
    throw new Error(`[${c.id}] routing assertion failed:\n    - ${problems.join('\n    - ')}`)
  }
}

function seedCase(c: SeedCase, outRoot: string) {
  const caseDir = join(outRoot, c.split, c.id)
  const repo = join(caseDir, 'repo')
  rmSync(caseDir, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })

  const { base, head } = buildTrees(c)

  git(repo, 'init', '--quiet', '--initial-branch=main')
  writeTree(repo, base)
  git(repo, 'add', '-A')
  git(repo, 'commit', '--quiet', '-m', 'base')
  const baseSha = git(repo, 'rev-parse', 'HEAD').trim()

  // Rewrite the whole tree so deletions are real deletions.
  for (const path of Object.keys(base)) {
    if (!(path in head)) rmSync(join(repo, path), { force: true })
  }
  writeTree(repo, head)
  git(repo, 'add', '-A')
  git(repo, 'commit', '--quiet', '-m', c.title)
  const headSha = git(repo, 'rev-parse', 'HEAD').trim()

  const unified = git(repo, 'diff', '--find-renames', `${baseSha}..${headSha}`)
  const files = changedFiles(repo, baseSha, headSha)

  // Expected routing is COMPUTED from the shipped policy, never hand-written.
  // The library's declared values are treated as an assertion: a mismatch is
  // either a library bug or a router bug, and both must stop the seed. Ground
  // truth that quietly disagrees with the policy it ships alongside is worse
  // than no ground truth, because every candidate is then graded against it.
  const plan = classifyDispatch(
    files.map((f) => f.path),
    POLICY as never,
  )
  assertRouting(c, plan)

  const request = {
    schema_version: '1.0.0',
    change: {
      id: c.id,
      title: c.title,
      description: c.description,
      author: 'corpus-author',
      base_ref: 'main',
      base_sha: baseSha,
      head_sha: headSha,
      merge_base_sha: baseSha,
    },
    workspace: { root: resolve(repo), base_root: null },
    diff: { unified, incremental: null, changed_files: files },
    policy: POLICY,
    trusted_context: {
      // Base-revision instruction files ONLY. If a case modifies AGENTS.md,
      // the trusted copy here is deliberately the pre-change one — that is the
      // whole point of the trust boundary (spec/01-review-request.md §1.6).
      instruction_files: [{ path: 'AGENTS.md', content: base['AGENTS.md'] }],
      reference_docs: [],
    },
    deterministic_audit: { rows: [] },
    prior_state: { ledger: null, author_replies: [] },
    run: {
      run_id: `run-${c.id}`,
      trigger: 'initial',
      actor: 'corpus',
      deadline_ms: 900_000,
    },
    // Failure injection is delivered as a TOP-LEVEL request field and is
    // documented in review-request.schema.json. It was previously tucked under
    // an undocumented `harness_directives` key, which no implementer could have
    // discovered — coverage-honesty scoring is unreachable without a channel the
    // candidate can actually see.
    ...(c.inject_failure ? { inject_failure: c.inject_failure } : {}),
  }

  const defects = c.defects.map((d: SeedDefect) => {
    const content = head[d.path]
    if (content === undefined) {
      throw new Error(`[${c.id}] defect ${d.defect_id} points at ${d.path}, absent from the head tree`)
    }
    const line = resolveAnchor(c.id, d.path, content, d.anchor)
    return {
      defect_id: d.defect_id,
      class: d.class,
      path: d.path,
      line_start: line,
      line_end: line + (d.span ?? 1) - 1,
      outside_diff: d.outside_diff ?? false,
      min_severity: d.min_severity,
      expected_category: d.expected_category,
      mechanism: d.mechanism,
      verification: d.verification,
      verification_note: d.verification_note ?? null,
      verification_command: d.verification_command ?? null,
    }
  })

  const decoys = (c.decoys ?? []).map((k) => {
    const content = head[k.path]
    if (content === undefined) {
      throw new Error(`[${c.id}] decoy ${k.decoy_id} points at ${k.path}, absent from the head tree`)
    }
    const line = resolveAnchor(c.id, k.path, content, k.anchor)
    return {
      decoy_id: k.decoy_id,
      path: k.path,
      line_start: line,
      line_end: line + (k.span ?? 1) - 1,
      why_not_a_defect: k.why_not_a_defect,
    }
  })

  const truth = {
    case_id: c.id,
    kind: c.kind,
    split: c.split,
    expected_tier: plan.tier,
    expected_overrides: plan.overrides,
    expected_council_includes: c.expected_council_includes,
    expected_council: plan.council,
    defects,
    decoys,
    inject_failure: c.inject_failure ?? null,
  }

  writeFileSync(join(caseDir, 'review-request.json'), `${JSON.stringify(request, null, 2)}\n`)
  writeFileSync(join(caseDir, 'truth.json'), `${JSON.stringify(truth, null, 2)}\n`)

  // Worked ReviewResults live in the SOURCE tree, not in the generated corpus.
  // They were previously authored straight into corpus/ and a --force reseed
  // destroyed them. Anything hand-authored must survive regeneration, or it is
  // one command away from being lost silently.
  const workedPath = join(import.meta.dir, 'worked-results', `${c.id}.json`)
  if (existsSync(workedPath)) {
    writeFileSync(join(caseDir, 'review-result.json'), readFileSync(workedPath, 'utf8'))
  }

  return { caseDir, defectCount: defects.length, decoyCount: decoys.length, fileCount: files.length }
}

function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outRoot = resolve(outIdx >= 0 ? args[outIdx + 1] : join(import.meta.dir, '..', 'corpus'))

  if (existsSync(outRoot) && !args.includes('--force')) {
    // Regenerating is cheap and deterministic, but silently replacing a corpus
    // a candidate has already been scored against invalidates the comparison.
    console.error(`corpus already exists at ${outRoot} — pass --force to regenerate`)
    process.exit(2)
  }

  // Clear the corpus root before writing.
  //
  // Per-case cleanup is not enough: renaming or reassigning a split leaves the
  // old directory behind, and every consumer that walks the corpus then sees
  // ghost cases. They validate, they carry plausible ground truth, and they
  // silently enter scoring. Wipe and regenerate — the corpus is deterministic,
  // so there is nothing to preserve.
  if (existsSync(outRoot)) {
    for (const entry of readdirSync(outRoot)) {
      rmSync(join(outRoot, entry), { recursive: true, force: true })
    }
  }
  mkdirSync(outRoot, { recursive: true })

  const ids = new Set<string>()
  const summary: Record<string, number> = { public: 0, dev: 0, blind: 0 }

  for (const c of LIBRARY) {
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`)
    ids.add(c.id)
    const r = seedCase(c, outRoot)
    summary[c.split]++
    console.log(
      `  ${c.split.padEnd(8)} ${c.id.padEnd(40)} ${r.fileCount} file(s), ${r.defectCount} defect(s), ${r.decoyCount} decoy(s)`,
    )
  }

  writeFileSync(
    join(outRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        corpus_version: CORPUS_VERSION,
        generated_from: 'src/defects/library-{a,b}.ts',
        counts: summary,
        case_ids: [...ids].sort(),
      },
      null,
      2,
    )}\n`,
  )

  console.log(`\nseeded ${ids.size} cases -> ${outRoot}`)
  console.log('next: bun src/verify.ts')
}

main()
