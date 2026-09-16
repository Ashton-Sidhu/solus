import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { HostKind } from '@solus/contracts/uplink'
import { bootLabHost } from './host'
import { LabIssuer } from './issuer'
import { runScenario, type ScenarioDefinition, type ScenarioRun } from './scenario'

/**
 * `bun lab run <scenario|all> [--host personal|managed|both]` (plan §8.3). Boots the
 * issuer and one host per flavor, runs the named scenarios against each, and exits
 * non-zero on any failed check. `lab up`, `lab as`, and the fleet protocol are the
 * next slice; every scenario here is what they will drive.
 */

const SCENARIOS_DIR = resolve(import.meta.dirname, '../scenarios')

/** A scenario file's default export, checked at the import boundary. */
const scenarioModuleSchema: z.ZodType<ScenarioDefinition> = z.object({
  name: z.string().min(1),
  only: z.enum(['personal', 'managed']).optional(),
  run: z.custom<ScenarioDefinition['run']>((value) => value instanceof Function),
})

function usage(): never {
  console.error('usage: bun lab run <scenario-name|all> [--host personal|managed|both] [--keep]')
  process.exit(2)
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
  if (command !== 'run' || !selector) usage()
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
  const runs: ScenarioRun[] = []
  try {
    for (const flavor of flavors) {
      const host = await bootLabHost({ flavor, issuer })
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
