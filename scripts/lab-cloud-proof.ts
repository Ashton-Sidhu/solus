/**
 * The cross-repository proof (docs/plans/multiplayer-sharing.md §9, Phase 1): grants
 * minted by a running Solus cloud control plane are admitted by a real Solus host.
 * The Lab boots a host whose link record names the cloud as its issuer; Alice links
 * it there, shares it with her organization, and Bob (a member), a guest with a
 * share link, and a non-member each try the host's ticket door and socket.
 *
 * Accounts are made with email + password and verified through the cloud dev
 * server's console mailer, so capture its stdout to a file and pass it as DEV_LOG.
 *
 *   ORIGIN=http://localhost:5178 DEV_LOG=/tmp/cloud-dev.log bun scripts/lab-cloud-proof.ts
 */
import { readFileSync } from 'node:fs'
import { io } from 'socket.io-client'
import { z } from 'zod'
import { bootLabHost, type LabHost } from '@solus/lab/host'

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5178'
const DEV_LOG = process.env.DEV_LOG ?? ''
const stamp = Date.now().toString(36)
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** Every answer is parsed at the boundary; a body that does not fit the schema fails the proof. */
async function parsed<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await response.json())
}

const idSchema = z.object({ id: z.string().min(1) })
const grantSchema = z.object({ grant: z.string().min(1), hostId: z.string().min(1) })
const enrolledSchema = z.object({ link: z.object({ hostId: z.string().min(1), issuer: z.string().min(1), jwksUrl: z.string().min(1) }) })
const ticketSchema = z.object({ ticket: z.string().min(1) })
const sessionSchema = z.object({ user: z.object({ id: z.string().min(1) }) }).nullable()
const envelopeSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional(),
})
type RpcEnvelope = z.infer<typeof envelopeSchema>
const infoSchema = z.object({ principal: z.string() })

async function cloud(path: string, init: RequestInit & { cookie?: string; origin?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.origin !== null) headers.set('origin', init.origin ?? ORIGIN)
  headers.set('accept', 'application/json')
  headers.set('connection', 'close')
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (init.cookie) headers.set('cookie', init.cookie)
  return fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' })
}

function verificationLinkFor(email: string): string | null {
  const log = readFileSync(DEV_LOG, 'utf8')
  const start = log.lastIndexOf(`to: '${email}'`)
  if (start < 0) return null
  return log.slice(start).match(/https?:\/\/[^\s"'\\]+verify-email[^\s"'\\]+/)?.[0] ?? null
}

async function signUp(name: string): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `${name.toLowerCase()}-${stamp}@example.test`
  const response = await cloud('/api/auth/sign-up/email', { method: 'POST', body: JSON.stringify({ name, email, password: `correct-${name}-battery-${stamp}-staple` }) })
  if (!response.ok) throw new Error(`${name} sign-up failed: ${response.status}`)
  let link: string | null = null
  for (let attempt = 0; attempt < 20 && !link; attempt++) {
    await new Promise((r) => setTimeout(r, 250))
    link = verificationLinkFor(email)
  }
  if (!link) throw new Error(`No verification link for ${email}`)
  const verified = await fetch(link, { redirect: 'manual' })
  const cookie = verified.headers.getSetCookie().map((entry) => entry.split(';')[0]).filter((entry) => entry && !entry.endsWith('=')).join('; ')
  const session = await parsed(await cloud('/api/auth/get-session', { cookie }), sessionSchema)
  if (!session) throw new Error(`${name} has no session`)
  return { cookie, userId: session.user.id, email }
}

async function ticketFor(host: LabHost, grant: string, shareSecret?: string): Promise<{ status: number; ticket?: string }> {
  const response = await fetch(`${host.tunnelUrl}/auth/ws-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${grant}`, 'content-type': 'application/json' },
    body: JSON.stringify(shareSecret ? { shareSecret } : {}),
  })
  if (!response.ok) return { status: response.status }
  return { status: response.status, ticket: (await parsed(response, ticketSchema)).ticket }
}

function dial(host: LabHost, ticket: string): Promise<{ socket: ReturnType<typeof io>; outcome: string }> {
  return new Promise((resolve) => {
    const socket = io(host.tunnelUrl, { path: '/ws', transports: ['websocket'], reconnection: false, auth: { ticket, clientInstanceId: `proof-${stamp}-0000000000` } })
    socket.once('connect', () => resolve({ socket, outcome: 'connected' }))
    socket.once('connect_error', (error: Error & { data?: { code?: string } }) => resolve({ socket, outcome: error.data?.code ?? error.message }))
  })
}

function rpc<T>(socket: ReturnType<typeof io>, method: string, args: unknown[], schema: z.ZodType<T>): Promise<{ result?: T; error?: RpcEnvelope['error'] }> {
  return new Promise((resolve) => socket.emit('rpc', `${Math.random()}`, method, args, (raw: z.input<typeof envelopeSchema>) => {
    const envelope = envelopeSchema.parse(raw)
    if (envelope.error) return resolve({ error: envelope.error })
    resolve({ result: schema.parse(envelope.result) })
  }))
}

if (!DEV_LOG) {
  console.error('DEV_LOG is required: the cloud dev server stdout, where the console mailer prints verification links.')
  process.exit(2)
}

const alice = await signUp('Alice')
const bob = await signUp('Bob')
const cara = await signUp('Cara')
const org = await parsed(await cloud('/api/auth/organization/create', { method: 'POST', cookie: alice.cookie, body: JSON.stringify({ name: `Proof ${stamp}`, slug: `proof-${stamp}` }) }), idSchema)
const invitation = await parsed(await cloud('/api/auth/organization/invite-member', { method: 'POST', cookie: alice.cookie, body: JSON.stringify({ email: bob.email, role: 'member', organizationId: org.id }) }), idSchema)
await cloud('/api/auth/organization/accept-invitation', { method: 'POST', cookie: bob.cookie, body: JSON.stringify({ invitationId: invitation.id }) })

// Alice links a host at the cloud; the Lab boots a real host whose link names the cloud.
const { ticket } = await parsed(await cloud('/v1/enrollment-tickets', { method: 'POST', cookie: alice.cookie }), ticketSchema)
const enrolled = await parsed(await cloud('/v1/hosts/enroll', { method: 'POST', origin: null, body: JSON.stringify({ ticket, installationId: `proof-${stamp}`, label: 'Proof host', os: 'macos', proxiedPort: 34118 }) }), enrolledSchema)
check('Alice linked a host at the cloud', /^[a-z2-7]{16}$/.test(enrolled.link.hostId), enrolled.link.hostId)
await cloud(`/v1/hosts/${enrolled.link.hostId}/organization`, { method: 'PUT', cookie: alice.cookie, body: JSON.stringify({ organizationId: org.id }) })

const host = await bootLabHost({ flavor: 'personal', issuer: { issuer: enrolled.link.issuer, jwksUrl: enrolled.link.jwksUrl }, hostId: enrolled.link.hostId })
console.log(`host ${host.hostId} at ${host.tunnelUrl} trusts ${enrolled.link.issuer}`)
const open: Array<ReturnType<typeof io>> = []
try {
  const aliceGrant = await parsed(await cloud(`/v1/hosts/${host.hostId}/grant`, { method: 'POST', cookie: alice.cookie }), grantSchema)
  const aliceTicket = await ticketFor(host, aliceGrant.grant)
  check('the host takes Alice\'s cloud grant at its ticket door', aliceTicket.status === 200)
  const aliceSocket = await dial(host, aliceTicket.ticket!)
  open.push(aliceSocket.socket)
  check('Alice\'s socket is admitted', aliceSocket.outcome === 'connected', aliceSocket.outcome)
  const aliceInfo = await rpc(aliceSocket.socket, 'connectionsGetServerInfo', [], infoSchema)
  check('Alice is the remote owner', aliceInfo.result?.principal === 'remote-owner', aliceInfo.result?.principal)
  const replay = await ticketFor(host, aliceGrant.grant)
  check('the same grant is refused a second time (jti consumed)', replay.status === 401)

  const bobGrant = await parsed(await cloud(`/v1/hosts/${host.hostId}/grant`, { method: 'POST', cookie: bob.cookie }), grantSchema)
  const bobTicket = await ticketFor(host, bobGrant.grant)
  check('the host takes Bob\'s member grant', bobTicket.status === 200)
  const bobSocket = await dial(host, bobTicket.ticket!)
  open.push(bobSocket.socket)
  const bobInfo = await rpc(bobSocket.socket, 'connectionsGetServerInfo', [], infoSchema)
  check('Bob is an organization member on the host', bobInfo.result?.principal === 'org-member', bobInfo.result?.principal)

  // The public guest door belongs to the workspace, never the runner.
  const oldGuestDoor = await cloud(`/v1/hosts/${host.hostId}/guest-grant`, { method: 'POST', origin: null, body: '{}' })
  check('the host guest-grant endpoint was removed', oldGuestDoor.status === 404)

  const caraGrant = await cloud(`/v1/hosts/${host.hostId}/grant`, { method: 'POST', cookie: cara.cookie })
  check('a non-member gets no grant from the cloud', caraGrant.status === 404)
} finally {
  for (const socket of open) socket.disconnect()
  await host.stop()
  await cloud(`/v1/hosts/${enrolled.link.hostId}`, { method: 'DELETE', cookie: alice.cookie })
}
console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
