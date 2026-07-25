// Seeded-defect library, part A: migration hazards, auth bypass, secrets,
// query performance, and logic precedence.
//
// Each case is a change against the shared fixture project. Truth anchors are
// content substrings; the seeder resolves them to line numbers.

import type { SeedCase } from './types.js'

export const LIBRARY_A: SeedCase[] = [
  // ---------------------------------------------------------------- migration
  {
    id: 'migration-nonconcurrent-index-dev',
    split: 'dev',
    kind: 'defective',
    title: 'Add index on orders.customer_id to speed up the customer view',
    description: 'The customer order list is slow. Adding an index on customer_id.',
    expected_tier: 'high',
    expected_overrides: ['migration_safety'],
    expected_council_includes: ['specialist-drizzle-migration-safety'],
    head: {
      'db/migrations/0042_index_customer_id.sql': `-- Speed up the per-customer order listing.
CREATE INDEX idx_orders_customer_id ON orders (customer_id);
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'sql-migration-hazard',
        path: 'db/migrations/0042_index_customer_id.sql',
        anchor: 'CREATE INDEX idx_orders_customer_id',
        min_severity: 'P1',
        expected_category: ['performance', 'correctness'],
        mechanism:
          'CREATE INDEX without CONCURRENTLY takes a SHARE lock on orders for the whole index build, blocking every INSERT and UPDATE. On a populated production table that is a multi-minute write outage during the pre-deploy migration window, while the previously-deployed binary is still serving writes.',
        verification: 'reasoned',
        verification_note:
          'No cheap mechanical oracle: the statement is valid SQL and applies instantly on an empty dev database. The hazard is lock behaviour under production load.',
      },
    ],
    decoys: [
      {
        decoy_id: 'k1',
        path: 'db/migrations/0041_add_notes_column.sql',
        anchor: 'ALTER TABLE orders ADD COLUMN notes text;',
        why_not_a_defect:
          'Adding a nullable column with no default is a catalog-only operation on modern Postgres. No table rewrite, no long lock. A reviewer flagging this is pattern-matching on "ALTER TABLE" rather than reasoning about the operation.',
      },
    ],
  },
  {
    id: 'migration-notnull-backfill-holdout',
    split: 'blind',
    kind: 'defective',
    title: 'Require a currency on every order',
    description: 'Orders now always carry a currency code.',
    expected_tier: 'high',
    expected_overrides: ['migration_safety'],
    expected_council_includes: ['specialist-drizzle-migration-safety'],
    head: {
      'db/migrations/0042_orders_currency_notnull.sql': `ALTER TABLE orders ADD COLUMN currency text NOT NULL DEFAULT 'USD';
ALTER TABLE orders ALTER COLUMN currency DROP DEFAULT;
`,
      'src/types.ts': `export type Request = {
  method: string
  path: string
  cookies: Record<string, string>
  query: Record<string, string>
  body: unknown
}

export type Order = {
  id: string
  tenantId: string
  customerId: string
  totalCents: number
  currency: string
  status: 'pending' | 'paid' | 'cancelled'
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'sql-migration-hazard',
        path: 'db/migrations/0042_orders_currency_notnull.sql',
        anchor: "ALTER COLUMN currency DROP DEFAULT",
        min_severity: 'P1',
        expected_category: ['correctness', 'performance'],
        mechanism:
          'Dropping the default in the same migration that adds the NOT NULL column breaks the previously-deployed binary, which is still inserting rows during the pre-deploy migration window and does not supply a currency. Those inserts fail with a not-null violation until the new binary is live.',
        verification: 'reasoned',
        verification_note:
          'Backward-compatibility hazard across the deploy window; only reasoning about the rollout order exposes it.',
      },
    ],
  },

  // -------------------------------------------------------------- auth bypass
  {
    id: 'auth-missing-tenant-scope-dev',
    split: 'public',
    kind: 'defective',
    title: 'Add an admin order-lookup endpoint',
    description: 'Support needs to look up an order by id without knowing the tenant.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-security'],
    head: {
      'src/routes.ts': `import { requireAuth, HttpError } from './auth.js'
import { getOrder, listOrders, getCustomerNames } from './db.js'
import type { Db } from './db.js'
import type { Request } from './types.js'
import type { Order } from './types.js'

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
  return orders.map((o) => ({ ...o, customerName: names.get(o.customerId) ?? null }))
}

/** Support tooling: look up any order by id. */
export async function handleAdminLookup(db: Db, req: Request) {
  requireAuth(req)
  const rows = await db.query<Order>('SELECT * FROM orders WHERE id = $1', [req.query.id])
  if (!rows[0]) throw new HttpError(404, 'not found')
  return rows[0]
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'auth-bypass',
        path: 'src/routes.ts',
        anchor: "'SELECT * FROM orders WHERE id = $1'",
        min_severity: 'P1',
        expected_category: ['security'],
        mechanism:
          'handleAdminLookup calls requireAuth but discards the identity and queries by id alone, with no tenant_id predicate. Any authenticated user of any tenant can read any order in the system by guessing or enumerating an id. This violates the AGENTS.md invariant that every order read is tenant-scoped.',
        verification: 'reasoned',
        verification_note:
          'Authorization gap. The code compiles and the happy-path test passes; the defect is the missing predicate.',
      },
      {
        defect_id: 'd2',
        class: 'missing-test',
        path: 'src/routes.ts',
        anchor: 'export async function handleAdminLookup',
        min_severity: 'P2',
        expected_category: ['testing'],
        mechanism:
          'A new exported request handler is added with no corresponding test in test/, contrary to the AGENTS.md rule that new branches in request handling require a test.',
        verification: 'mechanical',
        verification_command: '! grep -rq handleAdminLookup test/',
      },
    ],
    decoys: [
      {
        decoy_id: 'k1',
        path: 'src/routes.ts',
        anchor: 'const orders = await listOrders(db, tenantId)',
        why_not_a_defect:
          'This pre-existing call is correctly tenant-scoped through listOrders. It sits adjacent to the defective handler and is unchanged by this diff; flagging it is location-based pattern matching.',
      },
    ],
  },

  // ------------------------------------------------------------------ secrets
  {
    id: 'secret-hardcoded-token-dev',
    split: 'blind',
    kind: 'defective',
    title: 'Add webhook delivery for order status changes',
    description: 'Posts a webhook when an order transitions to paid.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-security'],
    head: {
      'src/webhook.ts': `import { loadConfig } from './config.js'

const SIGNING_KEY = 'whsec_9f3c1a77b204e58d61aa0f42c7e9b3d5'

export async function deliver(url: string, payload: unknown) {
  const config = loadConfig()
  if (!config.webhookAllowlist.includes(new URL(url).host)) {
    throw new Error('host not allowlisted')
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'x-signature': sign(JSON.stringify(payload), SIGNING_KEY) },
    body: JSON.stringify(payload),
  })
}

function sign(body: string, key: string): string {
  return \`\${key.slice(0, 6)}:\${body.length}\`
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'secret-in-diff',
        path: 'src/webhook.ts',
        anchor: 'const SIGNING_KEY',
        min_severity: 'P0',
        expected_category: ['security'],
        mechanism:
          'A webhook signing key is hardcoded in source. It is now in version control history permanently and readable by anyone with repository access. This must be detected before any model sees the diff, and the finding must cite the location without reproducing the value.',
        verification: 'mechanical',
        verification_command: 'grep -q "whsec_" src/webhook.ts',
      },
    ],
    decoys: [
      {
        decoy_id: 'k1',
        path: 'src/webhook.ts',
        anchor: 'config.webhookAllowlist.includes',
        why_not_a_defect:
          'The allowlist check is present and correctly precedes the request, so this is not an SSRF. A reviewer flagging outbound fetch on sight, without reading the guard above it, produces a false positive here.',
      },
    ],
  },

  // ------------------------------------------------------------------- n+1
  {
    id: 'perf-n-plus-one-dev',
    split: 'public',
    kind: 'defective',
    title: 'Include the shipping address on the order list',
    description: 'The list view now shows each order shipping address.',
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
  const enriched = []
  for (const o of orders) {
    const addr = await db.query<{ line1: string }>(
      'SELECT line1 FROM addresses WHERE order_id = $1',
      [o.id],
    )
    enriched.push({ ...o, customerName: names.get(o.customerId) ?? null, address: addr[0] ?? null })
  }
  return enriched
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'n-plus-one',
        path: 'src/routes.ts',
        anchor: "'SELECT line1 FROM addresses WHERE order_id = $1'",
        span: 3,
        min_severity: 'P1',
        expected_category: ['performance'],
        mechanism:
          'The address lookup is issued inside the per-order loop and awaited serially, so a tenant with N orders produces N sequential round trips. The adjacent getCustomerNames call in the same function already demonstrates the batched form this should have used.',
        verification: 'reasoned',
        verification_note:
          'Structurally detectable — an awaited query inside a for-of — but its severity depends on list size, which is a judgment call.',
      },
    ],
    decoys: [
      {
        decoy_id: 'k1',
        path: 'src/routes.ts',
        anchor: 'const names = await getCustomerNames(db, orders.map((o) => o.customerId))',
        why_not_a_defect:
          'This is the correctly batched form: one query for all customer ids, outside the loop. It is the counterexample sitting three lines above the real defect.',
      },
    ],
  },

  // ----------------------------------------------------------- logic ordering
  {
    id: 'logic-precedence-dev',
    split: 'public',
    kind: 'defective',
    title: 'Allow cancelling pending or unpaid orders',
    description: 'Cancellation should work for pending orders and for any order not yet paid.',
    expected_tier: 'medium',
    expected_overrides: [],
    expected_council_includes: ['specialist-correctness-general'],
    head: {
      'src/cancel.ts': `import { HttpError } from './auth.js'
import type { Order } from './types.js'

export function assertCancellable(order: Order, isAdmin: boolean): void {
  // Cancellable when the order is pending, or when it is not yet paid and the
  // caller is an admin.
  if (order.status === 'pending' || order.status !== 'paid' && isAdmin) {
    return
  }
  throw new HttpError(409, 'order is not cancellable')
}
`,
    },
    defects: [
      {
        defect_id: 'd1',
        class: 'logic-precedence',
        path: 'src/cancel.ts',
        anchor: "order.status === 'pending' || order.status !== 'paid' && isAdmin",
        min_severity: 'P1',
        expected_category: ['correctness'],
        mechanism:
          "&& binds tighter than ||, so this parses as pending || (notPaid && isAdmin). That matches the comment for admins, but a non-admin whose order is 'cancelled' correctly falls through — while an admin can cancel an already-cancelled order, producing a double-cancellation path the caller does not expect. The condition needs explicit parentheses and a status whitelist.",
        verification: 'reasoned',
        verification_note:
          'Operator-precedence reasoning against the stated intent in the comment directly above.',
      },
    ],
  },
]
