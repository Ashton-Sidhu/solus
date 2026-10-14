import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { signIn, type LabSignInClient, type SignedIn } from './cloud-sign-in'
import { bootLabHost, type LabHost } from './host'
import type { CloudPersonaId, LocalCloudStack } from './local-cloud'

/**
 * Scenarios against the local cloud (`bun lab run <name> --cloud`, after `bun lab up
 * --cloud`). They drive real accounts and the real token issuer; the Lab issuer plays no
 * part. Their files are in `scenarios/cloud/`.
 *
 * Each scenario starts clean and ends clean, so they run in any order: it boots its own
 * hosts (`ctx.bootHost`), and what it changes on the account it undoes with `ctx.defer`.
 * Its sign-ins are signed out at its end. The hosts' logs go to the run's evidence.
 */

const hostLogEntrySchema = z.object({
  ts: z.string().optional(),
  msg: z.string().optional(),
  level: z.string().optional(),
  userId: z.string().optional(),
  scope: z.string().optional(),
  grantId: z.string().optional(),
  code: z.string().optional(),
  hostId: z.string().optional(),
})
export type HostLogEntry = z.infer<typeof hostLogEntrySchema>

/** A host a scenario booted: not registered at first, stopped at the scenario's end. */
export interface CloudHost extends LabHost {
  /** The host's structured log entries so far (`SOLUS_DEV_LOG`). */
  log(): HostLogEntry[]
}

export interface CloudScenarioContext {
  stack: LocalCloudStack
  /** Headless authorization code + PKCE for the persona (`cloud-sign-in.ts`); signed out at the scenario's end. */
  signIn(personaId: CloudPersonaId, client?: LabSignInClient): Promise<SignedIn>
  /** A new host from the Lab build on a temporary data directory, registered to no account. */
  bootHost(options?: { flavor?: 'personal' | 'managed'; environment?: NodeJS.ProcessEnv }): Promise<CloudHost>
  /** Stops the host and starts it again on its data directory and ports, as a reboot does. */
  restartHost(host: CloudHost): Promise<CloudHost>
  /** Work for the scenario's end, run last first, whether it passed or not. */
  defer(name: string, work: () => Promise<unknown>): void
  /** Waits until `read` gives a value `accept` takes, or the time ends; the last value. */
  until<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, timeoutMs?: number): Promise<T>
  step(name: string): void
  check(name: string, ok: boolean, detail?: string): void
}

export interface CloudScenarioDefinition {
  name: string
  run(ctx: CloudScenarioContext): Promise<void>
}

export function cloudModeScenario(name: string, run: CloudScenarioDefinition['run']): CloudScenarioDefinition {
  return { name, run }
}

export interface CloudScenarioRun {
  name: string
  file: string
  checks: number
  failures: string[]
  teardownFailures: string[]
  durationMs: number
}

function readHostLog(path: string): HostLogEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      const entry = hostLogEntrySchema.safeParse(JSON.parse(line))
      return entry.success ? [entry.data] : []
    } catch {
      return []
    }
  })
}

export async function runCloudScenario(definition: CloudScenarioDefinition, file: string, stack: LocalCloudStack, runDir: string): Promise<CloudScenarioRun> {
  const startedAt = Date.now()
  const scenarioDir = join(runDir, file.replace(/\.ts$/, ''))
  mkdirSync(scenarioDir, { recursive: true })
  const timeline = (entry: { kind: 'step' | 'check' | 'teardown'; name: string; ok?: boolean; detail?: string }) =>
    appendFileSync(join(runDir, 'lab.log'), `${JSON.stringify({ at: Date.now(), scenario: file, ...entry })}\n`)
  const failures: string[] = []
  const teardownFailures: string[] = []
  const deferred: Array<{ name: string; work: () => Promise<unknown> }> = []
  let checks = 0
  let hosts = 0
  const restarts = new Map<string, { running: { current: LabHost }; flavor: 'personal' | 'managed'; environment?: NodeJS.ProcessEnv }>()
  const ctx: CloudScenarioContext = {
    stack,
    async signIn(personaId, client) {
      const signedIn = await signIn(stack, stack.personas[personaId], client)
      ctx.defer(`${personaId} signs out`, () => signedIn.oauth.signOut())
      return signedIn
    },
    async bootHost(options = {}) {
      hosts += 1
      const host = await bootLabHost({ flavor: options.flavor ?? 'personal', unregistered: true, environment: options.environment })
      const evidence = join(scenarioDir, `host-${hosts}`)
      const running = { current: host }
      ctx.defer(`host ${hosts} stops`, async () => {
        await running.current.stop()
        mkdirSync(evidence, { recursive: true })
        for (const name of ['dev.log', 'lab']) {
          const source = join(host.dataDir, name)
          if (existsSync(source)) cpSync(source, join(evidence, name), { recursive: true })
        }
        rmSync(host.dataDir, { recursive: true, force: true })
        rmSync(`${host.dataDir}-seats`, { recursive: true, force: true })
      })
      const cloudHost: CloudHost = { ...host, log: () => readHostLog(join(host.dataDir, 'dev.log')) }
      restarts.set(cloudHost.dataDir, { running, flavor: options.flavor ?? 'personal', environment: options.environment })
      return cloudHost
    },
    async restartHost(host) {
      const known = restarts.get(host.dataDir)
      if (!known) throw new Error('Only a host this scenario booted restarts')
      await known.running.current.stop()
      const port = Number(new URL(host.tunnelUrl).port)
      const bootedAt = new Date().toISOString()
      const restarted = await bootLabHost({ flavor: known.flavor, unregistered: true, dataDir: host.dataDir, tunnelPort: port, environment: known.environment })
      known.running.current = restarted
      const log = () => readHostLog(join(restarted.dataDir, 'dev.log'))
      // The server starts its log again at boot, a moment after it answers: wait for that, so no old entry reads as new.
      await ctx.until(() => log()[0]?.ts ?? '', (first) => first >= bootedAt, 10_000)
      return { ...restarted, log }
    },
    defer(name, work) {
      deferred.push({ name, work })
    },
    async until(read, accept, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      let value = await read()
      while (!accept(value) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
        value = await read()
      }
      return value
    },
    step(name) {
      timeline({ kind: 'step', name })
      console.log(`  · ${name}`)
    },
    check(name, ok, detail) {
      checks += 1
      timeline({ kind: 'check', name, ok, detail })
      if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
      console.log(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
    },
  }
  console.log(`\n▶ ${definition.name} [cloud]`)
  try {
    await definition.run(ctx)
  } catch (error) {
    ctx.check('scenario completed without an unexpected error', false, error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error))
  }
  for (const { name, work } of deferred.reverse()) {
    try {
      await work()
      timeline({ kind: 'teardown', name, ok: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      teardownFailures.push(`${name} — ${detail}`)
      timeline({ kind: 'teardown', name, ok: false, detail })
      console.log(`    TEARDOWN FAILED  ${name}  — ${detail}`)
    }
  }
  return { name: definition.name, file, checks, failures, teardownFailures, durationMs: Date.now() - startedAt }
}
