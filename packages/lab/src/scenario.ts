import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostKind } from '@solus/contracts/uplink'
import { LabClient, LabRpcError, type TimelineEntry } from './client'
import type { LabHost } from './host'
import type { LabIssuer } from './issuer'
import { PERSONAS, personaForHost } from './personas'

/**
 * The scenario DSL (plan §8.6): a named script over personas, with expectations that
 * name the refusal they want, and a timeline of every dial, call, and event.
 */

export interface ScenarioContext {
  hostKind: HostKind
  host: LabHost
  issuer: LabIssuer
  /** A connected client for the persona; the first call dials. */
  as(personaId: string): Promise<LabClient>
  /** A fresh, not yet connected client, for admission scenarios. */
  client(personaId: string, options?: { shareSecret?: string; grantTtlSeconds?: number; route?: 'tunnel' | 'local' }): LabClient
  /** A working directory sessions and works can use. */
  cwd: string
  step(name: string): void
  check(name: string, ok: boolean, detail?: string): void
  failures: string[]
}

export interface ScenarioDefinition {
  name: string
  /** Absent means both flavors. */
  only?: HostKind
  run(ctx: ScenarioContext): Promise<void>
}

export function scenario(name: string, run: ScenarioDefinition['run'], options: { only?: HostKind } = {}): ScenarioDefinition {
  return { name, run, only: options.only }
}

/** Awaits a call that must be refused with the given code. */
export async function expectRefused(ctx: ScenarioContext, name: string, call: Promise<unknown>, code = 'FORBIDDEN'): Promise<void> {
  try {
    await call
    ctx.check(name, false, 'the call succeeded')
  } catch (error) {
    const actual = error instanceof LabRpcError ? error.code : error instanceof Error ? error.message : String(error)
    ctx.check(name, actual === code, actual === code ? undefined : `refused with ${actual}: ${error instanceof Error ? error.message : ''}`)
  }
}

/** Awaits a call that must succeed; returns its value or undefined after recording the failure. */
export async function expectOk<T>(ctx: ScenarioContext, name: string, call: Promise<T>): Promise<T | undefined> {
  try {
    const value = await call
    ctx.check(name, true)
    return value
  } catch (error) {
    ctx.check(name, false, error instanceof Error ? `${error instanceof LabRpcError ? error.code : ''} ${error.message}` : String(error))
    return undefined
  }
}

export interface ScenarioRun {
  name: string
  hostKind: HostKind
  checks: number
  failures: string[]
  durationMs: number
}

export async function runScenario(definition: ScenarioDefinition, deps: { host: LabHost; issuer: LabIssuer; hostKind: HostKind; print?: boolean }): Promise<ScenarioRun> {
  const startedAt = Date.now()
  const clients = new Map<string, LabClient>()
  const timelinePath = join(deps.host.dataDir, 'lab', 'lab.log')
  const timeline = (entry: TimelineEntry | { at: number; kind: 'step' | 'check'; name: string; ok?: boolean; detail?: string }) => {
    appendFileSync(timelinePath, `${JSON.stringify({ scenario: definition.name, hostKind: deps.hostKind, ...entry })}\n`)
  }
  const print = deps.print ?? true
  const failures: string[] = []
  let checks = 0
  const ownerUserId = PERSONAS.alice.kind === 'org-member' ? PERSONAS.alice.userId : undefined
  const makeClient: ScenarioContext['client'] = (personaId, options = {}) => {
    const persona = personaForHost(personaId, deps.hostKind)
    const route = options.route ?? 'tunnel'
    if (route === 'local' && deps.hostKind !== 'personal') throw new Error('Only a personal host has a local-owner route')
    return new LabClient({
      persona,
      hostUrl: route === 'local' ? deps.host.localUrl : deps.host.tunnelUrl,
      issuer: deps.issuer,
      hostId: deps.host.hostId,
      hostKind: deps.hostKind,
      hostOwnerUserId: deps.hostKind === 'personal' ? ownerUserId : undefined,
      shareSecret: options.shareSecret,
      credentialFree: route === 'local',
      grantTtlSeconds: options.grantTtlSeconds,
      onTimeline: timeline,
    })
  }
  const ctx: ScenarioContext = {
    hostKind: deps.hostKind,
    host: deps.host,
    issuer: deps.issuer,
    cwd: deps.host.dataDir,
    failures,
    async as(personaId) {
      let client = clients.get(personaId)
      if (client?.connected) return client
      client = makeClient(personaId)
      const outcome = await client.connect()
      if (!outcome.ok) throw new Error(`${personaId} could not connect: ${JSON.stringify(outcome)}`)
      clients.set(personaId, client)
      return client
    },
    client: makeClient,
    step(name) {
      timeline({ at: Date.now(), kind: 'step', name })
      if (print) console.log(`  · ${name}`)
    },
    check(name, ok, detail) {
      checks += 1
      timeline({ at: Date.now(), kind: 'check', name, ok, detail })
      if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
      if (print) console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
    },
  }
  if (print) console.log(`\n▶ ${definition.name} [${deps.hostKind}]`)
  try {
    await definition.run(ctx)
  } catch (error) {
    ctx.check('scenario completed without an unexpected error', false, error instanceof Error ? error.message : String(error))
  } finally {
    for (const client of clients.values()) client.close()
  }
  return { name: definition.name, hostKind: deps.hostKind, checks, failures, durationMs: Date.now() - startedAt }
}
