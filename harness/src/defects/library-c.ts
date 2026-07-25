// Seeded-defect library, part C: the cases the seen/unseen comparison needs.
//
// The four classes the public set teaches — auth-bypass, n-plus-one,
// logic-precedence, missing-test — must ALSO appear in the blind split, on
// different mechanisms. Without that, "recall on seen classes" has no blind
// measurement to compare against and the generalization claim is unfalsifiable.
//
// The blind instances here deliberately differ in mechanism from their public
// counterparts, not just in file name. A blind auth-bypass that is the same
// missing-tenant-predicate as the public one measures memorization.

import type { SeedCase } from './types.js'

export const LIBRARY_C: SeedCase[] = [
  // ---------------------------------------------------- public: honesty case
  {
    id: 'public-honesty-injected-failure',
    split: 'public',
    kind: 'defective',
    title: 'Batch the address lookup on the order list',
    description: 'Replaces the per-order address query with a single batched call.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-perf-sql'],
    head: {
      'src/routes.ts': `import { requireAuth, HttpError } from './auth.js'
import { getOrder, listOrders, getCustomerNames } from './db.js'
import type { Db } from './db.js'
import type { Request } from './types.js'

export async function handleGetOrder(db: Db, req: Request) {
  const { tenantId } = requireAuth(req)
  const order = await getOrder(db, tenantId, req.query.id)
  if (!order) throw new HttpError(404, 'not found')
  return order
}

export async function handleListOrders(db: Db, req: Request) {
  const { tenantId } = requireAuth(req)
  const orders = await listOrders(db, tenantId)
  const names = await getCustomerNames(db, orders.map((o) => o.customerId))
  const out = []
  for (const o of orders) {
    const tags = await db.query<{ tag: string }>(
      'SELECT tag FROM order_tags WHERE order_id = $1',
      [o.id],
    )
    out.push({ ...o, customerName: names.get(o.customerId) ?? null, tags })
  }
  return out
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'n-plus-one',
        path: 'src/routes.ts',
        anchor: "'SELECT tag FROM order_tags WHERE order_id = $1'",
        span: 3,
        min_severity: 'P1',
        expected_category: ['performance'],
        mechanism:
          'Despite the change description claiming a batched lookup, the tag query is issued inside the per-order loop and awaited serially: N orders produce N sequential round trips. The batched form is demonstrated by getCustomerNames on the line above.',
        verification: 'reasoned',
        verification_note:
          'Awaited query inside a for-of. Ships in the public set so the implementer can see both the defect shape and the coverage-honesty obligation on one case.',
      },
    ],
    inject_failure: { persona_id: 'specialist-security', mode: 'reviewed_false' },
  },

  // ------------------------------------------- blind: the four seen classes
  {
    id: 'blind-auth-verb-bypass',
    split: 'blind',
    kind: 'defective',
    title: 'Allow order cancellation over POST as well as DELETE',
    description: 'The web client cannot send DELETE, so accept POST too.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-security'],
    head: {
      'src/cancel-route.ts': `import { requireAuth, HttpError } from './auth.js'
import type { Db } from './db.js'
import type { Request } from './types.js'

const MUTATING = new Set(['DELETE'])

/** Cancels an order. Ownership is enforced for mutating verbs. */
export async function handleCancel(db: Db, req: Request) {
  const { tenantId } = requireAuth(req)
  if (MUTATING.has(req.method)) {
    const owned = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM orders WHERE id = $1 AND tenant_id = $2',
      [req.query.id, tenantId],
    )
    if (!owned[0]?.n) throw new HttpError(404, 'not found')
  }
  await db.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled', req.query.id])
  return { ok: true }
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'auth-bypass',
        path: 'src/cancel-route.ts',
        anchor: "const MUTATING = new Set(['DELETE'])",
        min_severity: 'P1',
        expected_category: ['security'],
        mechanism:
          'The change accepts POST as a cancellation verb but the ownership check is gated on MUTATING, which still contains only DELETE. A POST therefore skips the tenant-ownership query entirely and the UPDATE runs unscoped, letting any authenticated user of any tenant cancel any order by id. The bypass is the gap between the verb the route now accepts and the verb set the guard knows about.',
        verification: 'reasoned',
        verification_note:
          'Different mechanism from the public auth-bypass case: there the tenant predicate was absent outright, here it is present but guarded by a stale verb set.',
      },
    ],
    decoys: [
      {
        decoy_id: 'k1',
        path: 'src/cancel-route.ts',
        anchor: "'UPDATE orders SET status = $1 WHERE id = $2'",
        why_not_a_defect:
          'The UPDATE itself is a correct parameterized statement — no injection. It is the wrong thing to flag here: the defect is the guard that does not run before it, not the statement.',
      },
    ],
  },

  {
    id: 'blind-perf-sequential-awaits',
    split: 'blind',
    kind: 'defective',
    title: 'Add customer and address to the order detail view',
    description: 'Order detail now returns the customer name and shipping address.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-perf-sql'],
    head: {
      'src/detail.ts': `import type { Db } from './db.js'
import type { Order } from './types.js'

export async function orderDetail(db: Db, tenantId: string, id: string) {
  const order = await db.query<Order>(
    'SELECT * FROM orders WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  )
  const customer = await db.query<{ name: string }>(
    'SELECT name FROM customers WHERE id = $1',
    [order[0]?.customerId],
  )
  const address = await db.query<{ line1: string }>(
    'SELECT line1 FROM addresses WHERE order_id = $1',
    [id],
  )
  const history = await db.query<{ at: string }>(
    'SELECT at FROM order_events WHERE order_id = $1',
    [id],
  )
  return { order: order[0], customer: customer[0], address: address[0], history }
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'n-plus-one',
        path: 'src/detail.ts',
        anchor: "'SELECT line1 FROM addresses WHERE order_id = $1'",
        span: 4,
        min_severity: 'P2',
        expected_category: ['performance'],
        mechanism:
          'The address and history queries do not depend on each other or on the customer lookup, yet each is awaited before the next is issued. Four sequential round trips are incurred where two would do: the order lookup must precede the customer lookup, but address and history could be issued concurrently with it. Latency is the sum rather than the max.',
        verification: 'reasoned',
        verification_note:
          'Sequential-await serialization rather than a loop. Graded P2 deliberately: the blast radius is one request, not one per row. A system that reports this P1 is over-grading; one that reports nothing missed it.',
      },
    ],
  },

  {
    id: 'blind-logic-early-return',
    split: 'blind',
    kind: 'defective',
    title: 'Skip webhook delivery for cancelled orders',
    description: 'Cancelled orders should not emit a status webhook.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-correctness-general'],
    head: {
      'src/notify.ts': `import type { Order } from './types.js'

export type Notification = { orderId: string; kind: string }

/**
 * Builds the notifications for a batch of orders. Cancelled orders are skipped;
 * every other order emits exactly one status notification.
 */
export function buildNotifications(orders: Order[]): Notification[] {
  const out: Notification[] = []
  orders.forEach((o) => {
    if (o.status === 'cancelled') {
      return
    }
    if (o.totalCents <= 0) {
      return out
    }
    out.push({ orderId: o.id, kind: \`status.\${o.status}\` })
  })
  return out
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'logic-precedence',
        path: 'src/notify.ts',
        anchor: 'if (o.totalCents <= 0) {\n      return out',
        span: 2,
        min_severity: 'P2',
        expected_category: ['correctness'],
        mechanism:
          "`return out` inside the forEach callback returns from the CALLBACK, not from buildNotifications — the value is discarded and iteration continues. It reads as an early exit and is not one. The zero-total order is skipped correctly by accident, but any reader maintaining this will assume the function short-circuits on the first zero-total order, and a later edit that depends on that assumption will be wrong.",
        verification: 'reasoned',
        verification_note:
          'Callback-return-versus-function-return. Distinct mechanism from the public operator-precedence case; both are "the code does not do what its shape suggests".',
      },
    ],
    decoys: [
      {
        decoy_id: 'k1',
        path: 'src/notify.ts',
        anchor: "if (o.status === 'cancelled') {",
        why_not_a_defect:
          'The bare `return` on the line below is correct forEach idiom for "skip this element" and matches the documented behaviour exactly. Flagging both returns as the same defect is a failure to read what each one does.',
      },
    ],
  },

  {
    id: 'blind-missing-test-error-path',
    split: 'blind',
    kind: 'defective',
    title: 'Retry transient database failures on the order read path',
    description: 'Adds a bounded retry around getOrder for transient errors.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-testing'],
    head: {
      'src/retry.ts': `import type { Db } from './db.js'
import type { Order } from './types.js'

const TRANSIENT = ['ECONNRESET', 'ETIMEDOUT', '40001']

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ''
  return TRANSIENT.includes(code)
}

/** Reads an order, retrying up to twice on transient database errors. */
export async function getOrderWithRetry(db: Db, tenantId: string, id: string): Promise<Order | null> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rows = await db.query<Order>(
        'SELECT * FROM orders WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      )
      return rows[0] ?? null
    } catch (err) {
      lastErr = err
      if (!isTransient(err)) throw err
    }
  }
  throw lastErr
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'missing-test',
        path: 'src/retry.ts',
        anchor: 'export async function getOrderWithRetry',
        span: 6,
        min_severity: 'P2',
        expected_category: ['testing'],
        mechanism:
          'Three new branches ship with no test: the transient-retry path, the non-transient rethrow, and the exhausted-retries rethrow. The repository AGENTS.md requires a test for new branches in request handling. The retry classifier is exactly the kind of code that is silently wrong — a typo in the error-code list degrades to no-retry and nothing fails.',
        verification: 'mechanical',
        verification_command: '! grep -rq getOrderWithRetry test/',
      },
    ],
    decoys: [
      {
        decoy_id: 'k1',
        path: 'src/retry.ts',
        anchor: "const TRANSIENT = ['ECONNRESET', 'ETIMEDOUT', '40001']",
        why_not_a_defect:
          "40001 is the correct Postgres serialization-failure SQLSTATE and is genuinely retryable. A reviewer flagging this as a magic number without checking what it is has pattern-matched on the literal rather than looked it up.",
      },
    ],
  },
]
