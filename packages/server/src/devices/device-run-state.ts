import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DEVICE_RUN_MODES, DEVICE_RUN_TARGETS, type DeviceRun } from '@solus/contracts/device-types'

const storedRunsSchema = z.array(z.object({
  run: z.object({
    runId: z.string(), profileName: z.string(), checkout: z.string(), checkoutPath: z.string(), projectPath: z.string(),
    branch: z.string().nullable(), mode: z.enum(DEVICE_RUN_MODES), target: z.enum(DEVICE_RUN_TARGETS).nullable().catch(null),
    source: z.enum(['main', 'conversation']), commit: z.string(), outputCommit: z.string().optional(),
    deviceHostId: z.string().nullable(), deviceId: z.string().nullable(), deviceName: z.string().nullable(),
    stage: z.enum(['preparing', 'starting', 'running', 'stopping', 'building', 'installing', 'done', 'failed', 'cancelled']),
    lastLine: z.string().nullable(), error: z.string().nullable(), buildId: z.string().nullable(),
    startedAt: z.number(), endedAt: z.number().nullable(),
  }),
  log: z.string().max(200_000), truncated: z.boolean(),
})).max(10)

export interface StoredDeviceRun { run: DeviceRun; log: string; truncated: boolean }

/** Latest app run per source and action, bounded and written atomically in the owned device directory. */
export class DeviceRunState {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly path: string) {}

  load(): StoredDeviceRun[] {
    try {
      const parsed = storedRunsSchema.safeParse(JSON.parse(readFileSync(this.path, 'utf8')))
      return parsed.success ? parsed.data : []
    } catch { return [] }
  }

  save(records: StoredDeviceRun[]): Promise<void> {
    const content = JSON.stringify(records.slice(0, 10))
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, content, { mode: 0o600 })
      await rename(temporary, this.path)
    })
    this.writes = write
    return write
  }
}
