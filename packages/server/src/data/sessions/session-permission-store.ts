import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { PermissionMode } from '@solus/contracts/types'

const modes = z.record(z.string(), z.enum(['supervised', 'accept-edits', 'auto', 'full-access', 'plan']))

/** Last user-authorized policy, independent of provider processes and turns. */
export class SessionPermissionStore {
  private readonly values: Map<string, PermissionMode>
  constructor(private readonly file?: string) {
    let stored: { [sessionId: string]: PermissionMode } = {}
    if (file) {
      try { stored = modes.parse(JSON.parse(readFileSync(file, 'utf8'))) } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    this.values = new Map(Object.entries(stored))
  }
  get(sessionId: string): PermissionMode | undefined { return this.values.get(sessionId) }
  set(sessionId: string, mode: PermissionMode): void {
    if (this.values.get(sessionId) === mode) return
    this.values.set(sessionId, mode)
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const pending = `${this.file}.pending`
    writeFileSync(pending, JSON.stringify(Object.fromEntries(this.values)), { mode: 0o600 })
    renameSync(pending, this.file)
  }
}
