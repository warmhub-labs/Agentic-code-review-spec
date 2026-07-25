// Shared types for the seeded-defect library.

export type DefectClass =
  | 'sql-migration-hazard'
  | 'auth-bypass'
  | 'secret-in-diff'
  | 'n-plus-one'
  | 'logic-precedence'
  | 'missing-test'
  | 'ci-workflow-injection'
  | 'cross-file-latent'
  | 'prompt-injection-surface'
  | 'doc-drift'

/**
 * Three splits, distinguished by who may see the ground truth.
 *
 *  public — SHIPPED TO THE IMPLEMENTER WITH FULL GROUND TRUTH, plus a scorer.
 *           Their legitimate iteration loop. Covers a deliberate SUBSET of the
 *           defect classes; the classes it omits are the generalization test.
 *  dev    — hidden. Our iteration set, for tuning the harness itself.
 *  blind  — hidden and sealed. Covers every class. Run once per candidate.
 *           This is the only split whose numbers get reported.
 *
 * The distinction that matters: a class appearing in `public` is SEEN — the
 * implementer was told to catch it. A class appearing only in hidden splits is
 * UNSEEN, and recall on unseen classes measures whether the system generalizes
 * from the specification or pattern-matches to its examples.
 *
 * Note what is unavoidably public regardless: the routing policy names the
 * personas, so the LANE taxonomy is visible by construction. What is hidden is
 * the defect-class taxonomy and every specific seeded mechanism.
 */
export type Split = 'public' | 'dev' | 'blind'

/**
 * A truth entry whose location is expressed as an ANCHOR SUBSTRING rather than
 * a line number. The seeder resolves it against the generated head tree.
 *
 * Hardcoded line numbers in a generated corpus rot the first time a template
 * changes, and they rot silently — the ground truth still validates, it just
 * points somewhere else. Anchoring on content makes that failure loud: the
 * seeder cannot find the substring and refuses to emit the case.
 */
export type SeedDefect = {
  defect_id: string
  class: DefectClass
  path: string
  /** Substring that must appear exactly once in the head file. */
  anchor: string
  /** Lines spanned by the defect, starting at the anchor line. */
  span?: number
  outside_diff?: boolean
  min_severity: 'P0' | 'P1' | 'P2' | 'P3'
  expected_category: string[]
  mechanism: string
  verification: 'mechanical' | 'reasoned'
  verification_note?: string
  verification_command?: string
}

export type SeedDecoy = {
  decoy_id: string
  path: string
  anchor: string
  span?: number
  why_not_a_defect: string
}

export type SeedCase = {
  id: string
  split: Split
  kind: 'defective' | 'clean'
  /** Human-readable change title; becomes ReviewRequest.change.title. */
  title: string
  description: string
  expected_tier: 'low' | 'medium' | 'high' | 'critical'
  expected_overrides: string[]
  expected_council_includes: string[]
  /** Extra files present at BASE, beyond the shared fixture. */
  baseExtra?: Record<string, string>
  /** Files written at HEAD. This is the change under review. */
  head: Record<string, string>
  /** Files deleted at HEAD. */
  headDeletes?: string[]
  defects: SeedDefect[]
  decoys?: SeedDecoy[]
  inject_failure?: {
    persona_id: string
    mode: 'malformed_json' | 'timeout' | 'reviewed_false' | 'missing_summary'
  }
}
