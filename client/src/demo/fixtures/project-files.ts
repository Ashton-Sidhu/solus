import { DEMO_PROJECT } from './types'

// A plausible source tree for the fixture "acme" project shown throughout the
// demo (git status, diffs, PR, and session transcripts all reference these
// same paths) so opening a file in the Files pane looks continuous with the
// rest of the scripted demo.
const contents: Record<string, string> = {
  'package.json': `{
  "name": "acme",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "redis": "^4.7.0",
    "drizzle-orm": "^0.33.0",
    "stripe": "^17.0.0",
    "nanoid": "^5.0.0"
  }
}
`,

  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src"]
}
`,

  'README.md': `# acme

Public API for acme links: authenticated routing, per-key rate limiting, and Stripe-backed usage billing.

## Development

    bun install
    bun run dev

## Testing

    bun test
`,

  '.gitignore': `node_modules
dist
.env
`,

  'src/env.ts': `export const env = process.env as Record<string, string | undefined>
`,

  'src/config.ts': `import { env } from './env'

const intEnv = (name: string, fallback: number) => Number.parseInt(env[name] ?? String(fallback), 10)

export const config = {
  port: Number(env.PORT ?? 3000),
  redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
  rateLimit: {
    mode: (env.RATE_LIMIT_MODE ?? 'shadow') as 'shadow' | 'enforce',
    capacity: intEnv('RATE_LIMIT_CAPACITY', 200),
    refillPerSecond: intEnv('RATE_LIMIT_REFILL_PER_SECOND', 50),
  },
}
`,

  'src/api/types.ts': `import type { ApiKey, ApiKeyStore } from '../auth/apiKey'
import type { Redis } from '../infra/redis'
import type { config } from '../config'

export interface ApiContext {
  Variables: { apiKey: ApiKey }
}

export interface ApiDeps {
  apiKeys: ApiKeyStore
  redis: Redis
  config: typeof config
  db: Database
}

export type Middleware = (request: MiddlewareRequest, next: () => Promise<Response>) => Promise<Response>

export interface MiddlewareRequest {
  headers: Headers
  context: { apiKey: ApiKey }
  response: { headers: Headers }
  id: string
  log: { warn(fields: Record<string, unknown>, message: string): void }
  json(body: unknown, status?: number): Response
}

interface Database {
  insert(table: string): { values(row: Record<string, unknown>): Promise<void> }
  query(table: string): { where(match: Record<string, unknown>): { first(): Promise<unknown> } }
}
`,

  'src/api/router.ts': `import { Hono } from 'hono'
import { authenticateApiKey } from '../auth/apiKey'
import { rateLimit } from '../middleware/rateLimit'
import { linkRoutes } from './links'
import type { ApiContext, ApiDeps } from './types'

export function createApiRouter(deps: ApiDeps) {
  const api = new Hono<ApiContext>()

  api.use('/v1/*', authenticateApiKey(deps.apiKeys))
  api.use('/v1/*', rateLimit({
    redis: deps.redis,
    policy: deps.config.rateLimit,
    mode: deps.config.rateLimit.mode,
    now: Date.now,
  }))
  api.route('/v1/links', linkRoutes(deps))

  return api
}
`,

  'src/api/links.ts': `import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import type { ApiContext, ApiDeps } from './types'

export function linkRoutes(deps: ApiDeps) {
  const links = new Hono<ApiContext>()

  links.post('/', async (c) => {
    const { url } = await c.req.json<{ url: string }>()
    const slug = nanoid(8)
    await deps.db.insert('links').values({ slug, url, accountId: c.get('apiKey').accountId })
    return c.json({ slug, url }, 201)
  })

  links.get('/:slug', async (c) => {
    const link = await deps.db.query('links').where({ slug: c.req.param('slug') }).first()
    if (!link) return c.notFound()
    return c.json(link)
  })

  return links
}
`,

  'src/api/analytics.ts': `import { recordUsage } from '../billing/usageRecorder'
import { requestCount } from '../telemetry/metrics'

export async function recordApiRequest(accountId: string, route: string, status: number) {
  requestCount.increment({ accountId })
  await recordUsage(accountId, currentBillingPeriod())

  if (status >= 500) console.error(\`[analytics] \${route} failed for account \${accountId}\`)
}

function currentBillingPeriod(): string {
  const now = new Date()
  return \`\${now.getUTCFullYear()}-\${String(now.getUTCMonth() + 1).padStart(2, '0')}\`
}
`,

  'src/auth/apiKey.ts': `import type { Middleware } from '../api/types'

export interface ApiKey {
  id: string
  accountId: string
  token: string
  revokedAt: string | null
}

export interface ApiKeyStore {
  findByToken(token: string): Promise<ApiKey | null>
}

export function authenticateApiKey(apiKeys: ApiKeyStore): Middleware {
  return async (request, next) => {
    const token = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return request.json({ error: { code: 'missing_api_key' } }, 401)

    const apiKey = await apiKeys.findByToken(token)
    if (!apiKey || apiKey.revokedAt) {
      return request.json({ error: { code: 'invalid_api_key' } }, 401)
    }

    request.context.apiKey = apiKey
    return next()
  }
}
`,

  'src/infra/redis.ts': `import { createClient } from 'redis'
import { config } from '../config'

export type Redis = ReturnType<typeof createClient>

export const redis: Redis = createClient({ url: config.redisUrl })
redis.on('error', (error) => console.error('[redis] connection error', error))
void redis.connect()
`,

  'src/middleware/rateLimit.ts': `import type { Middleware } from '../api/types'
import type { Redis } from '../infra/redis'
import { consumeTokenBucket, type RateLimitPolicy } from '../ratelimit/tokenBucket'
import { rateLimitDecisions } from '../telemetry/metrics'

interface RateLimitDeps {
  redis: Redis
  policy: RateLimitPolicy
  mode: 'shadow' | 'enforce'
  now: () => number
}

export function rateLimit(deps: RateLimitDeps): Middleware {
  return async (request, next) => {
    const apiKeyId = request.context.apiKey.id
    try {
      const decision = await consumeTokenBucket(
        deps.redis,
        \`ratelimit:\${apiKeyId}\`,
        deps.policy,
        deps.now(),
      )
      request.response.headers.set('RateLimit-Limit', String(decision.limit))
      request.response.headers.set('RateLimit-Remaining', String(decision.remaining))
      request.response.headers.set('RateLimit-Reset', String(Math.ceil(decision.resetAfterMs / 1000)))

      if (!decision.allowed && deps.mode === 'enforce') {
        rateLimitDecisions.add(1, { outcome: 'blocked' })
        request.response.headers.set('Retry-After', String(Math.ceil(decision.resetAfterMs / 1000)))
        return request.json({ error: { code: 'rate_limit_exceeded', message: 'Too many requests', requestId: request.id } }, 429)
      }

      rateLimitDecisions.add(1, { outcome: decision.allowed ? 'allowed' : 'shadow_blocked' })
      return next()
    } catch (error) {
      request.log.warn({ error, apiKeyId }, 'rate limiter unavailable')
      rateLimitDecisions.add(1, { outcome: 'fail_open' })
      return next()
    }
  }
}
`,

  'src/ratelimit/tokenBucket.ts': `import type { Redis } from '../infra/redis'

export interface RateLimitPolicy {
  capacity: number
  refillPerSecond: number
}

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  resetAfterMs: number
}

const TOKEN_BUCKET_SCRIPT = \`
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens')) or tonumber(ARGV[1])
local updated_at = tonumber(redis.call('HGET', KEYS[1], 'updated_at')) or tonumber(ARGV[3])
local elapsed = math.max(0, tonumber(ARGV[3]) - updated_at)
tokens = math.min(tonumber(ARGV[1]), tokens + elapsed * tonumber(ARGV[2]) / 1000)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_at', ARGV[3])
redis.call('PEXPIRE', KEYS[1], math.ceil(tonumber(ARGV[1]) / tonumber(ARGV[2]) * 2000))
local reset_ms = math.ceil(math.max(0, 1 - tokens) / tonumber(ARGV[2]) * 1000)
return { allowed and 1 or 0, math.floor(tokens), reset_ms }
\`

export async function consumeTokenBucket(
  redis: Redis,
  key: string,
  policy: RateLimitPolicy,
  nowMs: number,
): Promise<RateLimitDecision> {
  const [allowed, remaining, resetAfterMs] = await redis.eval(
    TOKEN_BUCKET_SCRIPT,
    [key],
    [policy.capacity, policy.refillPerSecond, nowMs],
  ) as [number, number, number]

  return {
    allowed: allowed === 1,
    limit: policy.capacity,
    remaining,
    resetAfterMs,
  }
}
`,

  'src/ratelimit/tokenBucket.test.ts': `import { afterAll, beforeEach, expect, test } from 'bun:test'
import { redis } from '../test/redis'
import { consumeTokenBucket } from './tokenBucket'

const key = 'test:ratelimit:key-1'
const policy = { capacity: 2, refillPerSecond: 1 }
const now = Date.parse('2026-07-14T12:00:00.000Z')

beforeEach(() => redis.del(key))
afterAll(() => redis.disconnect())

test('allows requests until capacity is exhausted', async () => {
  expect((await consumeTokenBucket(redis, key, policy, now)).allowed).toBe(true)
  expect((await consumeTokenBucket(redis, key, policy, now)).allowed).toBe(true)
  const denied = await consumeTokenBucket(redis, key, policy, now)
  expect(denied.allowed).toBe(false)
  expect(denied.remaining).toBe(0)
  expect(denied.resetAfterMs).toBe(1000)
})

test('refills fractional tokens without exceeding capacity', async () => {
  await consumeTokenBucket(redis, key, policy, now)
  await consumeTokenBucket(redis, key, policy, now)
  expect((await consumeTokenBucket(redis, key, policy, now + 500)).allowed).toBe(false)
  expect((await consumeTokenBucket(redis, key, policy, now + 1000)).allowed).toBe(true)
  expect((await consumeTokenBucket(redis, key, policy, now + 10000)).remaining).toBe(1)
})

test('only one concurrent request consumes the final token', async () => {
  await consumeTokenBucket(redis, key, { capacity: 1, refillPerSecond: 1 }, now)
  await redis.hset(key, { tokens: 1, updated_at: now })
  const consume = () => consumeTokenBucket(redis, key, { capacity: 1, refillPerSecond: 1 }, now)
  const decisions = await Promise.all([consume(), consume()])
  expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1)
})
`,

  'src/queue/webhookQueue.ts': `import { redis } from '../infra/redis'

const RETRY_KEY = 'webhook:retries'

export interface DeliveryJob {
  id: string
  endpointId: string
  url: string
  payload: string
  attempt: number
}

export async function acknowledge(id: string) {
  await redis.zrem(RETRY_KEY, id)
}

export async function retry(
  job: DeliveryJob,
  delayMs: number,
  now: () => number = Date.now,
) {
  await redis.zadd(
    RETRY_KEY,
    now() + delayMs,
    JSON.stringify({ ...job, attempt: job.attempt + 1 }),
  )
}
`,

  'src/webhooks/deliveryWorker.ts': `import * as queue from '../queue/webhookQueue'
import type { DeliveryJob } from '../queue/webhookQueue'
import { backoff } from './retryPolicy'

function requestFor(job: DeliveryJob): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-attempt': String(job.attempt) },
    body: job.payload,
  }
}

export async function deliver(job: DeliveryJob) {
  const response = await fetch(job.url, requestFor(job))
  if (response.ok) {
    await queue.acknowledge(job.id)
    return
  }
  await queue.retry(job, backoff(job.attempt + 1))
}
`,

  'src/webhooks/deliveryWorker.test.ts': `import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import * as queue from '../queue/webhookQueue'
import { redis } from '../infra/redis'
import { deliver } from './deliveryWorker'
import type { DeliveryJob } from '../queue/webhookQueue'

const fetchMock = mock()

function deliveryJob(overrides: Partial<DeliveryJob> = {}): DeliveryJob {
  return {
    id: 'job-1',
    endpointId: 'endpoint-1',
    url: 'https://example.com/hooks',
    payload: '{}',
    attempt: 0,
    ...overrides,
  }
}

function response(status: number): Response {
  return new Response(null, { status })
}

beforeEach(() => {
  globalThis.fetch = fetchMock
  queue.acknowledge = mock()
  queue.retry = mock()
})

afterEach(() => fetchMock.mockReset())

test('acknowledges a successful delivery once', async () => {
  fetchMock.mockResolvedValue(response(200))

  await deliver(deliveryJob())

  expect(queue.acknowledge).toHaveBeenCalledWith('job-1')
  expect(queue.retry).not.toHaveBeenCalled()
})

test('keeps attempts isolated across interleaved deliveries', async () => {
  const first = deliveryJob({ id: 'job-a', endpointId: 'endpoint-1', attempt: 0 })
  const second = deliveryJob({ id: 'job-b', endpointId: 'endpoint-1', attempt: 3 })
  fetchMock.mockResolvedValue(response(503))

  await Promise.all([deliver(first), deliver(second)])

  expect(queue.retry).toHaveBeenCalledWith(first, 1000)
  expect(queue.retry).toHaveBeenCalledWith(second, 8000)
})

test('schedules retries against the injected clock', async () => {
  const now = () => Date.parse('2026-07-14T16:00:00.000Z')
  await queue.retry(deliveryJob({ attempt: 1 }), 2000, now)
  expect(redis.zadd).toHaveBeenCalledWith(
    'webhook:retries',
    Date.parse('2026-07-14T16:00:02.000Z'),
    expect.any(String),
  )
})
`,

  'src/webhooks/retryPolicy.ts': `const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

export function backoff(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1))
}
`,

  'src/webhooks/retryPolicy.test.ts': `import { expect, test } from 'bun:test'
import { backoff } from './retryPolicy'

test('doubles the delay for each additional attempt', () => {
  expect(backoff(1)).toBe(1_000)
  expect(backoff(2)).toBe(2_000)
  expect(backoff(3)).toBe(4_000)
})

test('caps the delay at the configured maximum', () => {
  expect(backoff(10)).toBe(30_000)
})
`,

  'src/db/schema/apiKeys.ts': `import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  token: text('token').notNull(),
  label: text('label'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
})
`,

  'src/db/schema/billing.ts': `import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  plan: text('plan').notNull(),
  status: text('status').notNull(),
})

export const usageRecords = pgTable('usage_records', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  period: text('period').notNull(),
  requestCount: integer('request_count').notNull(),
  reportedAt: timestamp('reported_at'),
})
`,

  'src/dashboard/usage.ts': `import { readUsage } from '../billing/usageRecorder'

export interface DateRange {
  start: number
  end: number
}

export interface UsageSummary {
  accountId: string
  requestCount: number
  stripeSubscriptionItemId: string
}

export async function getUsage(accountId: string, range: DateRange): Promise<UsageSummary> {
  const period = \`\${range.start}-\${range.end}\`
  const requestCount = await readUsage(accountId, period)

  return { accountId, requestCount, stripeSubscriptionItemId: \`si_\${accountId}\` }
}
`,

  'src/billing/usageRecorder.ts': `import { redis } from '../infra/redis'

function usageKey(accountId: string, period: string) {
  return \`usage:\${accountId}:\${period}\`
}

export async function recordUsage(accountId: string, period: string) {
  await redis.hIncrBy(usageKey(accountId, period), 'requests', 1)
}

export async function readUsage(accountId: string, period: string): Promise<number> {
  const value = await redis.hGet(usageKey(accountId, period), 'requests')
  return Number(value ?? 0)
}
`,

  'src/billing/syncSubscription.ts': `import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { subscriptions } from '../db/schema/billing'
import { stripe } from './stripeClient'

export async function syncSubscription(id: string) {
  const subscription = await stripe.subscriptions.retrieve(id)
  const plan = subscription.items.data[0]?.price.lookup_key ?? 'free'

  await db
    .update(subscriptions)
    .set({ plan, status: subscription.status })
    .where(eq(subscriptions.stripeSubscriptionId, id))

  return subscription
}
`,

  'src/billing/reconcileUsage.ts': `import { db } from '../db/client'
import { usageRecords } from '../db/schema/billing'
import { getUsage } from '../dashboard/usage'
import { stripe } from './stripeClient'

export async function reconcileUsage(accountId: string, periodStart: number, periodEnd: number) {
  const usage = await getUsage(accountId, { start: periodStart, end: periodEnd })

  await db.insert(usageRecords).values({
    accountId,
    period: \`\${periodStart}-\${periodEnd}\`,
    requestCount: usage.requestCount,
  })

  await stripe.subscriptionItems.createUsageRecord(usage.stripeSubscriptionItemId, {
    quantity: usage.requestCount,
    timestamp: periodEnd,
    action: 'set',
  })
}
`,

  'src/billing/invoiceWebhook.ts': `import type Stripe from 'stripe'
import { reconcileUsage } from './reconcileUsage'
import { syncSubscription } from './syncSubscription'

export async function handleInvoiceWebhook(event: Stripe.Event) {
  switch (event.type) {
    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice
      if (invoice.subscription) await syncSubscription(invoice.subscription as string)
      if (invoice.metadata?.accountId) {
        await reconcileUsage(invoice.metadata.accountId, invoice.period_start, invoice.period_end)
      }
      break
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      console.warn(\`[billing] payment failed for invoice \${invoice.id}\`)
      break
    }
    default:
      break
  }
}
`,

  'docs/api/rate-limits.md': `# API limits

acme applies a token bucket to each API key. Short bursts are allowed up to the plan capacity; tokens then refill continuously.

| Plan | Sustained rate | Burst capacity |
| --- | ---: | ---: |
| Free | 5 req/s | 20 |
| Pro | 50 req/s | 200 |
| Business | 200 req/s | 800 |

Every authenticated response includes:

- \`RateLimit-Limit\`: bucket capacity
- \`RateLimit-Remaining\`: whole tokens remaining
- \`RateLimit-Reset\`: seconds until one token is available

Rejected requests return \`429 Too Many Requests\` and include \`Retry-After\`.

\`\`\`json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Too many requests",
    "requestId": "req_01J2..."
  }
}
\`\`\`

Contact support before planned traffic spikes.
`,
}

export const demoProjectFiles = {
  root: DEMO_PROJECT,
  files: Object.keys(contents).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
  contents,
}
