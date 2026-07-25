// The shared base project every corpus case starts from.
//
// Deliberately small but structurally realistic: a service with an auth
// boundary, a data layer, SQL migrations, a CI workflow, instruction files, and
// tests. Every defect class in the library needs a plausible place to live, and
// a fixture that is too toy makes seeded defects unrealistically easy to spot.
//
// Keys are repo-relative paths; values are file contents.

export const FIXTURE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'orders-service',
      version: '1.0.0',
      type: 'module',
      scripts: { test: 'node --test test/' },
    },
    null,
    2,
  ),

  'AGENTS.md': `# orders-service

## Invariants

- Every route that reads or writes order data MUST pass through \`requireAuth\`
  and MUST scope its query by \`tenantId\`. There is no such thing as a
  cross-tenant order read.
- Secrets are read from the environment at startup via \`loadConfig()\`. Never
  inline a credential in source.
- Migrations run as a pre-deploy step, BEFORE the new binary serves traffic.
  The previously-deployed binary is still writing during the migration window,
  so every migration must be backward-compatible with it at each intermediate
  step.
- New branches in request handling require a test in \`test/\`.
`,

  'src/config.ts': `export type Config = {
  databaseUrl: string
  sessionSecret: string
  webhookAllowlist: string[]
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL
  const sessionSecret = process.env.SESSION_SECRET
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!sessionSecret) throw new Error('SESSION_SECRET is required')
  return {
    databaseUrl,
    sessionSecret,
    webhookAllowlist: (process.env.WEBHOOK_ALLOWLIST ?? '').split(',').filter(Boolean),
  }
}
`,

  'src/auth.ts': `import type { Request } from './types.js'

/** Resolves the caller identity from the session cookie. Null when anonymous. */
export function resolveIdentity(req: Request): { userId: string; tenantId: string } | null {
  const token = req.cookies['session']
  if (!token) return null
  const parsed = verifySession(token)
  return parsed ? { userId: parsed.sub, tenantId: parsed.tenant } : null
}

/**
 * Route guard. Throws 401 when anonymous.
 *
 * IMPORTANT: this establishes identity only. Callers remain responsible for
 * scoping their queries by the returned tenantId — see AGENTS.md.
 */
export function requireAuth(req: Request): { userId: string; tenantId: string } {
  const identity = resolveIdentity(req)
  if (!identity) throw new HttpError(401, 'unauthenticated')
  return identity
}

export function verifySession(token: string): { sub: string; tenant: string } | null {
  // Signature verification elided for the fixture.
  const [sub, tenant, sig] = token.split('.')
  return sig ? { sub, tenant } : null
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
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
  status: 'pending' | 'paid' | 'cancelled'
}
`,

  'src/db.ts': `import type { Order } from './types.js'

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
}

export async function getOrder(db: Db, tenantId: string, id: string): Promise<Order | null> {
  const rows = await db.query<Order>(
    'SELECT * FROM orders WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  )
  return rows[0] ?? null
}

export async function listOrders(db: Db, tenantId: string): Promise<Order[]> {
  return db.query<Order>('SELECT * FROM orders WHERE tenant_id = $1', [tenantId])
}

export async function getCustomerNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const rows = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM customers WHERE id = ANY($1)',
    [ids],
  )
  return new Map(rows.map((r) => [r.id, r.name]))
}
`,

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
  return orders.map((o) => ({ ...o, customerName: names.get(o.customerId) ?? null }))
}
`,

  'db/migrations/0041_add_notes_column.sql': `-- Adding a nullable column with no default is metadata-only on PG11+.
-- No table rewrite, no long lock.
ALTER TABLE orders ADD COLUMN notes text;
`,

  '.github/workflows/ci.yml': `name: ci

on:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
`,

  'test/routes.test.js': `import { test } from 'node:test'
import assert from 'node:assert'
import { handleGetOrder } from '../src/routes.js'

const db = {
  async query() {
    return [{ id: 'o1', tenantId: 't1', customerId: 'c1', totalCents: 100, status: 'paid' }]
  },
}

test('handleGetOrder returns the order for an authenticated caller', async () => {
  const req = { method: 'GET', path: '/orders', cookies: { session: 'u1.t1.sig' }, query: { id: 'o1' }, body: null }
  const order = await handleGetOrder(db, req)
  assert.equal(order.id, 'o1')
})
`,

  'README.md': `# orders-service

Order management for the storefront. Routes live in \`src/routes.ts\`; the
data layer is \`src/db.ts\`. Migrations apply in lexicographic filename order.
`,
}
