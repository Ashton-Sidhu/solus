import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { HostKind } from '@solus/contracts/uplink'
import { buildLabHost } from './build'
import { runCloudScenario, type CloudScenarioDefinition, type CloudScenarioRun } from './cloud-mode'
import { LAB_CLOUD_DIR, readStack, startLocalCloud, stopLocalCloud, STACK_FILE } from './local-cloud'
import { bootLabHost } from './host'
import { LabIssuer } from './issuer'
import { ORGANIZATION_ID } from './personas'
import { bootLabSolusApi } from './solus-api'
import { runScenario, type ScenarioDefinition, type ScenarioRun } from './scenario'

/**
 * `bun lab run <scenario|all> [--host personal|managed|both]` (plan §8.3). Boots the
 * issuer and one host per flavor, runs the named scenarios against each, and exits
 * non-zero on any failed check. `bun lab build` makes the host the Lab boots.
 * `bun lab up --cloud` starts the local cloud and a host and leaves them running;
 * `bun lab run <scenario> --cloud` runs a scenario of `scenarios/cloud/` against them;
 * `bun lab down` stops them. `lab as` and the fleet protocol are the next slice.
 */

const SCENARIOS_DIR = resolve(import.meta.dirname, '../scenarios')

/** A scenario file's default export, checked at the import boundary. */
const scenarioModuleSchema: z.ZodType<ScenarioDefinition> = z.object({
  name: z.string().min(1),
  only: z.enum(['personal', 'managed']).optional(),
  run: z.custom<ScenarioDefinition['run']>((value) => value instanceof Function),
})

function usage(): never {
  console.error([
    'usage: bun lab build',
    '       bun lab run <scenario-name|all> [--host personal|managed|both] [--keep]',
    '       bun lab up --cloud | bun lab down',
    '       bun lab run <scenario-name|all> --cloud',
  ].join('\n'))
  process.exit(2)
}

/** A cloud-mode scenario file's default export (`scenarios/cloud/`). */
const cloudScenarioModuleSchema: z.ZodType<CloudScenarioDefinition> = z.object({
  name: z.string().min(1),
  run: z.custom<CloudScenarioDefinition['run']>((value) => value instanceof Function),
})

async function runCloud(selector: string): Promise<number> {
  const stack = readStack()
  const dir = resolve(SCENARIOS_DIR, 'cloud')
  const files = readdirSync(dir).filter((file) => file.endsWith('.ts')).sort()
  const chosen = selector === 'all' ? files : files.filter((file) => file === `${selector}.ts` || file === selector)
  if (chosen.length === 0) throw new Error(`No cloud scenario named "${selector}" in ${dir}`)
  // One evidence directory per run; `bun lab down` keeps it.
  const startedAt = new Date()
  const runDir = resolve(LAB_CLOUD_DIR, 'evidence', `run-${startedAt.toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(runDir, { recursive: true })
  console.log(`== local cloud ${stack.origin} · evidence ${runDir}`)
  const runs: CloudScenarioRun[] = []
  for (const file of chosen) {
    const module: { default?: unknown } = await import(resolve(dir, file))
    runs.push(await runCloudScenario(cloudScenarioModuleSchema.parse(module.default), file, stack, runDir))
  }
  const cloudLog = stack.processes.find((entry) => entry.name === 'cloud')?.log
  if (cloudLog && existsSync(cloudLog)) cpSync(cloudLog, join(runDir, 'cloud.log'))
  const passed = (run: CloudScenarioRun) => run.failures.length === 0 && run.teardownFailures.length === 0
  writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify({ startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), origin: stack.origin, scenarios: runs.map((run) => ({ ...run, passed: passed(run) })) }, null, 2)}\n`)
  console.log('\n== report')
  for (const run of runs) {
    for (const failure of run.failures) console.log(`  ✗ ${run.file}: ${failure}`)
    for (const failure of run.teardownFailures) console.log(`  ✗ ${run.file} teardown: ${failure}`)
  }
  const width = Math.max(...runs.map((run) => run.file.length))
  for (const run of runs) {
    console.log(`${passed(run) ? 'PASS' : 'FAIL'}  ${run.file.replace(/\.ts$/, '').padEnd(width)}  ${String(run.checks).padStart(3)} checks  ${String(run.failures.length).padStart(2)} failed  ${String(Math.round(run.durationMs / 100) / 10).padStart(5)} s`)
  }
  console.log(`${runs.filter(passed).length}/${runs.length} passed · ${runDir}`)
  return runs.every(passed) ? 0 : 1
}

async function loadScenarios(selector: string): Promise<ScenarioDefinition[]> {
  const files = readdirSync(SCENARIOS_DIR).filter((file) => file.endsWith('.ts')).sort()
  const chosen = selector === 'all' ? files : files.filter((file) => file === `${selector}.ts` || file === selector)
  if (chosen.length === 0) throw new Error(`No scenario named "${selector}" in ${SCENARIOS_DIR}`)
  const loaded: ScenarioDefinition[] = []
  for (const file of chosen) {
    const module: { default?: unknown } = await import(resolve(SCENARIOS_DIR, file))
    loaded.push(scenarioModuleSchema.parse(module.default))
  }
  return loaded
}

export async function main(argv: string[]): Promise<number> {
  const [command, selector, ...rest] = argv
  if (command === 'build') {
    const built = await buildLabHost()
    console.log(`Built ${built.entry} in ${built.durationMs} ms`)
    return 0
  }
  if (command === 'up') {
    if (selector !== '--cloud') usage()
    const stack = await startLocalCloud()
    console.log(`Local cloud up: ${stack.origin}\nHost: ${stack.host.localUrl} (tunnel listener ${stack.host.tunnelUrl})\nFacts: ${STACK_FILE}\nLogs: ${stack.evidenceDir}`)
    return 0
  }
  if (command === 'down') {
    const stack = await stopLocalCloud()
    console.log(`Stopped ${stack.processes.map((entry) => `${entry.name} ${entry.pid}`).join(', ')}\nEvidence kept: ${stack.evidenceDir}`)
    return 0
  }
  if (command !== 'run' || !selector) usage()
  if (rest.includes('--cloud')) {
    if (rest.length !== 1) usage()
    return runCloud(selector)
  }
  let hostFlag: 'personal' | 'managed' | 'both' = 'both'
  let keep = false
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--host') {
      const value = rest[++index]
      if (value !== 'personal' && value !== 'managed' && value !== 'both') usage()
      hostFlag = value
    } else if (rest[index] === '--keep') keep = true
    else usage()
  }
  const flavors: HostKind[] = hostFlag === 'both' ? ['personal', 'managed'] : [hostFlag]
  const scenarios = await loadScenarios(selector)
  const issuer = new LabIssuer()
  await issuer.start()
  // Organization work needs the Solus API to admit a new session before the provider
  // starts (plans/009-organization-vms.md §4, §9): every link the issuer issues names
  // this one. A scenario that boots its own Solus API puts this route back after it.
  const solusApi = await bootLabSolusApi({ issuer, engine: 'sqlite' })
  issuer.setWorkspaceRoute(solusApi.url)
  const runs: ScenarioRun[] = []
  try {
    for (const flavor of flavors) {
      // A personal host that members reach is shared with the organization and holds
      // its key, so it can act for them (ADR 0001 stage 4); a managed host registers
      // its key from the environment link.
      const host = await bootLabHost({ flavor, issuer, runnerOf: flavor === 'personal' ? ORGANIZATION_ID : undefined })
      console.log(`\n== ${flavor} host ${host.hostId} · data ${host.dataDir} · tunnel ${host.tunnelUrl} · local ${host.localUrl}`)
      try {
        for (const definition of scenarios) {
          if (definition.only && definition.only !== flavor) continue
          runs.push(await runScenario(definition, { host, issuer, hostKind: flavor }))
        }
      } finally {
        await host.stop()
        if (keep) console.log(`kept ${host.dataDir}`)
      }
    }
  } finally {
    await solusApi.stop()
    await issuer.stop()
  }
  const failed = runs.filter((run) => run.failures.length > 0)
  console.log('\n== report')
  for (const run of runs) {
    console.log(`${run.failures.length === 0 ? 'PASS' : 'FAIL'}  ${run.name} [${run.hostKind}]  ${run.checks} checks, ${run.failures.length} failed, ${run.durationMs} ms`)
    for (const failure of run.failures) console.log(`      ✗ ${failure}`)
  }
  return failed.length === 0 ? 0 : 1
}
