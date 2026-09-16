import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ScenarioContext } from './scenario'

/**
 * Invariants the scenarios call between steps (plan §8.5). Each one names the rule it
 * encodes. They read the host only through RPC as the personas do; the host's truth
 * is what those personas can observe.
 */

/** Access: on a managed host no person is ever admitted as the local owner (§3.3, §13). */
export async function checkNoLocalOwnerOnManaged(ctx: ScenarioContext, personaIds: string[]): Promise<void> {
  if (ctx.hostKind !== 'managed') return
  for (const personaId of personaIds) {
    const client = await ctx.as(personaId)
    const info = await client.rpc('connectionsGetServerInfo')
    ctx.check(`oracle/access: ${personaId} is not a local owner on the managed host`, info.principal !== 'local-owner' && info.principal !== 'remote-owner', `principal=${info.principal}`)
  }
}

/** Ownership: exactly one owner, and the share list agrees with who may open it (§3.4). */
export async function checkOwnership(ctx: ScenarioContext, resource: { kind: 'session' | 'work'; id: string }, expectedOwnerUserId: string, readers: Record<string, boolean>): Promise<void> {
  for (const [personaId, mayOpen] of Object.entries(readers)) {
    const client = await ctx.as(personaId)
    try {
      const list = await client.rpc('shareGet', { resource })
      ctx.check(`oracle/ownership: ${personaId} sees ${resource.kind} ${resource.id} owned by ${expectedOwnerUserId}`, mayOpen && list.ownerUserId === expectedOwnerUserId, `owner=${list.ownerUserId} callerRole=${list.callerRole}`)
    } catch (error) {
      ctx.check(`oracle/ownership: ${personaId} cannot open ${resource.kind} ${resource.id}`, !mayOpen, error instanceof Error ? error.message : String(error))
    }
  }
}

/** One run the mock backend was handed, as it recorded it (tests/e2e/mock/mock-backend.ts). */
const recordedRunSchema = z.object({
  at: z.number(),
  prompt: z.string(),
  seat: z.object({
    userId: z.string(),
    provider: z.string(),
    home: z.string(),
    isHostLogin: z.literal(true).optional(),
    envToken: z.string().optional(),
  }).nullable(),
})
export type RecordedRun = z.infer<typeof recordedRunSchema>

/** Every run the host's mock backend has started, oldest first. */
export function recordedRuns(ctx: ScenarioContext): RecordedRun[] {
  const file = join(ctx.host.dataDir, 'lab', 'mock-runs.ndjson')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => recordedRunSchema.parse(JSON.parse(line)))
}

/**
 * Seats: a turn runs on exactly the seat its author owns; the host owner's seat is
 * the host login (`host-owner`). A run with the wrong seat, or none, is the
 * invariant this step exists to hold (docs/plans/provider-seats.md §3.3).
 */
export function checkSeatOfRun(ctx: ScenarioContext, promptMarker: string, expectedSeatUserId: string): RecordedRun | undefined {
  const run = recordedRuns(ctx).findLast((candidate) => candidate.prompt.includes(promptMarker))
  if (!run) {
    ctx.check(`oracle/seats: a run for "${promptMarker}" reached the provider`, false, 'no recorded run')
    return undefined
  }
  const actual = run.seat?.userId ?? null
  ctx.check(`oracle/seats: "${promptMarker}" ran on ${expectedSeatUserId}'s seat`, actual === expectedSeatUserId, `seat=${actual ?? 'none'}`)
  return run
}

/** Lists never leak: an id a persona cannot open never appears in their listing (§3.7). */
export async function checkWorkListing(ctx: ScenarioContext, personaId: string, workId: string, expected: boolean): Promise<void> {
  const client = await ctx.as(personaId)
  const works = await client.rpc('listWorks', ctx.cwd)
  const listed = works.some((work) => work.id === workId)
  ctx.check(`oracle/listing: ${personaId} ${expected ? 'sees' : 'does not see'} work ${workId} in listWorks`, listed === expected)
}
