// The routing/publication policy shipped with the corpus.
//
// Portable analogue of the reference system's risk-policy document, scoped to
// the fixture project. Candidates receive this verbatim in every ReviewRequest;
// routing accuracy (protocol/scoring.md §3.5) is measured against it.
//
// Note the shape of the tier councils: the council barely shrinks as the tier
// drops. What varies with tier is coordinator depth, publication permissiveness,
// the P3 cap, and the turn budget. That is a deliberate recall-over-cost stance
// — see spec/02-risk-routing.md §2.5.

export const POLICY = {
  version: '2',

  riskTierRules: {
    critical: [] as string[],
    high: ['src/auth.ts', 'db/migrations/**'],
    medium: ['src/**'],
    low: ['**'],
  },

  dispatchPolicy: {
    critical: {
      council: [
        'specialist-correctness-general',
        'specialist-security',
        'specialist-perf-sql',
        'specialist-testing',
        'specialist-consistency',
        'specialist-general-reviewer',
      ],
      councilParallel: true,
      finalFreshCouncil: ['skeptic', 'specialist-security'],
      maxProjectionTokens: 8000,
      publication: {
        INITIAL: { publish: ['P0', 'P1', 'P2', 'P3'], p3Cap: 20, reversalHandling: 'require_justification' },
        FIX_VERIFICATION: { publish: ['P0', 'P1', 'P2'], reversalHandling: 'require_justification' },
        AUTHOR_RESPONSE_REVIEW: { publish: [], reversalHandling: 'auto_retract' },
        CONVERGENCE: { publish: ['P0', 'P1'], reversalHandling: 'require_justification' },
        FINAL_FRESH: { publish: ['P0', 'P1', 'P2'], reversalHandling: 'allow_independent' },
      },
      halt: { zeroOpen: ['P0', 'P1', 'P2'], zeroNewThisTurn: ['P0', 'P1'], maxTurns: 15 },
      stateMachine: { mandatoryStates: ['FINAL_FRESH'] },
    },
    high: {
      council: [
        'specialist-correctness-general',
        'specialist-security',
        'specialist-perf-sql',
        'specialist-testing',
        'specialist-consistency',
        'specialist-general-reviewer',
      ],
      councilParallel: true,
      finalFreshCouncil: ['specialist-general-reviewer'],
      maxProjectionTokens: 8000,
      publication: {
        INITIAL: { publish: ['P0', 'P1', 'P2', 'P3'], p3Cap: 15, reversalHandling: 'require_justification' },
        FIX_VERIFICATION: { publish: ['P0', 'P1', 'P2'], reversalHandling: 'require_justification' },
        AUTHOR_RESPONSE_REVIEW: { publish: [], reversalHandling: 'auto_retract' },
        CONVERGENCE: { publish: ['P0', 'P1'], reversalHandling: 'require_justification' },
        FINAL_FRESH: { publish: ['P0', 'P1', 'P2'], reversalHandling: 'allow_independent' },
      },
      halt: { zeroOpen: ['P0', 'P1'], zeroNewThisTurn: ['P0', 'P1'], maxTurns: 12 },
      stateMachine: { mandatoryStates: ['FINAL_FRESH'] },
    },
    medium: {
      council: [
        'specialist-correctness-general',
        'specialist-security',
        'specialist-perf-sql',
        'specialist-testing',
        'specialist-consistency',
      ],
      councilParallel: true,
      finalFreshCouncil: ['specialist-general-reviewer'],
      maxProjectionTokens: 6000,
      publication: {
        INITIAL: { publish: ['P0', 'P1', 'P2', 'P3'], p3Cap: 10, reversalHandling: 'require_justification' },
        FIX_VERIFICATION: { publish: ['P0', 'P1', 'P2'], reversalHandling: 'require_justification' },
        AUTHOR_RESPONSE_REVIEW: { publish: [], reversalHandling: 'auto_retract' },
        CONVERGENCE: { publish: ['P0', 'P1'], reversalHandling: 'require_justification' },
        FINAL_FRESH: { publish: ['P0', 'P1'], reversalHandling: 'allow_independent' },
      },
      halt: { zeroOpen: ['P0', 'P1'], zeroNewThisTurn: ['P0', 'P1', 'P2'], maxTurns: 8 },
    },
    low: {
      council: [
        'specialist-correctness-general',
        'specialist-security',
        'specialist-perf-sql',
        'specialist-testing',
        'specialist-consistency',
      ],
      councilParallel: true,
      finalFreshCouncil: ['specialist-general-reviewer'],
      maxProjectionTokens: 4000,
      publication: {
        INITIAL: { publish: ['P0', 'P1', 'P2', 'P3'], p3Cap: 5, reversalHandling: 'require_justification' },
        FIX_VERIFICATION: { publish: ['P0', 'P1', 'P2'], reversalHandling: 'require_justification' },
        AUTHOR_RESPONSE_REVIEW: { publish: [], reversalHandling: 'auto_retract' },
        CONVERGENCE: { publish: ['P0', 'P1'], reversalHandling: 'require_justification' },
        FINAL_FRESH: { publish: ['P0', 'P1'], reversalHandling: 'allow_independent' },
      },
      halt: { zeroOpen: ['P0', 'P1'], zeroNewThisTurn: ['P0', 'P1', 'P2'], maxTurns: 5 },
    },
  },

  dispatchOverrides: {
    // Subtractive: fires only when EVERY changed file is documentation.
    docs_only: {
      _comment:
        'Pure-docs change: skip the council. The coordinator still runs to enforce publication policy. Instruction files are EXCLUDED — a change to AGENTS.md is a trusted-instruction surface and must reach the council.',
      test: ['**/*.md', '**/*.mdx', 'docs/**'],
      exclude: ['AGENTS.md', '**/AGENTS.md', 'CLAUDE.md', '**/CLAUDE.md'],
      appliesTo: ['low', 'medium'],
      match: 'every',
      effect: { council: [], finalFreshCouncil: [] },
    },

    // Subtractive: lockfiles and generated output carry no review signal.
    lockfile_or_generated: {
      test: ['**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.min.js', '**/*.map'],
      exclude: ['db/migrations/**', '**/migrations/**'],
      appliesTo: ['low', 'medium'],
      match: 'every',
      effect: { council: [], finalFreshCouncil: [] },
    },

    // Additive: appliesTo "*" because a topic reviewer's relevance is fully
    // answered by its file scope. Hand-listing tiers silently drops coverage
    // when the same topic routes to different tiers by path.
    migration_safety: {
      test: ['db/migrations/**', '**/migrations/**', 'src/migrate.ts'],
      appliesTo: '*',
      match: 'any',
      effect: {},
      addCouncil: ['specialist-drizzle-migration-safety'],
    },

    // Additive: CI trust-boundary coverage.
    ci_workflow: {
      test: ['.github/**'],
      appliesTo: '*',
      match: 'any',
      effect: {},
      addCouncil: ['specialist-ci-workflow-reviewer'],
    },
  },

  subtractEnabled: {
    docs_only: true,
    lockfile_or_generated: true,
    migration_safety: true,
    ci_workflow: true,
  },

  waiverPolicy: {
    P0: { actors: ['team:leads'], requiresReason: true, requiresDocumentation: true },
    P1: { actors: ['team:platform', 'team:security'], requiresReason: true, requiresDocumentation: false },
    P2: { actors: ['role:maintainer', 'role:codeowner'], requiresReason: true, requiresDocumentation: false },
    P3: { actors: ['role:author', 'role:maintainer'], requiresReason: false, requiresDocumentation: false },
  },

  budget: {
    maxCostPerReviewUsd: 5.0,
    perTurnTimeoutSeconds: 900,
    maxInlineComments: 30,
    maxSummaryFindings: 50,
    maxBodyBytes: 60000,
  },
} as const
