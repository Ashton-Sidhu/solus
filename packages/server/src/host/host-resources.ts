import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import type { HostResources } from '@solus/contracts/host-resources'

/** Many clients cost one read. */
const READ_TTL_MS = 5_000
/** CPU use is a difference of two counter reads. */
const CPU_WINDOW_MS = 200
const VM_STAT_TIMEOUT_MS = 1_000

interface CpuCounters {
  idle: number
  total: number
  count: number
}

function readCpuCounters(): CpuCounters {
  const list = cpus()
  let idle = 0
  let total = 0
  for (const { times } of list) {
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total, count: list.length }
}

/** Null when a core went offline or a counter ran backward between the reads. */
export function cpuUtilizationBetween(before: CpuCounters, after: CpuCounters): number | null {
  const total = after.total - before.total
  const idle = after.idle - before.idle
  if (before.count !== after.count || total <= 0 || idle < 0) return null
  return Math.min(1, Math.max(0, 1 - idle / total))
}

/** `MemAvailable` counts page cache the kernel can give back; `os.freemem` does not. */
export function linuxAvailableMemory(meminfo: string): number | null {
  const kilobytes = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]
  return kilobytes ? Number(kilobytes) * 1024 : null
}

/** Adapted from T3 Code `HostResources.ts` (MIT, see resources/licenses/t3code-resource-monitor.txt).
 *  `vm_stat` keeps speculative pages out of free, so they are added once. */
export function darwinAvailableMemory(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1]
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1]
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1]
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1]
  if (!pageSize || !free || !inactive || !speculative) return null
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize)
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null
}

function vmStat(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/bin/vm_stat', { timeout: VM_STAT_TIMEOUT_MS }, (error, stdout) => resolve(error ? '' : stdout))
  })
}

async function readAvailableMemory(): Promise<number> {
  // On Windows, libuv's free memory is ullAvailPhys, which includes standby memory.
  const fallback = freemem()
  if (process.platform === 'linux') return linuxAvailableMemory(await readFile('/proc/meminfo', 'utf8').catch(() => '')) ?? fallback
  if (process.platform === 'darwin') return darwinAvailableMemory(await vmStat()) ?? fallback
  return fallback
}

async function sampleHostResources(): Promise<HostResources> {
  const before = readCpuCounters()
  await new Promise((resolve) => setTimeout(resolve, CPU_WINDOW_MS))
  const after = readCpuCounters()
  const totalMemoryBytes = totalmem()
  return {
    sampledAt: Date.now(),
    cpuUtilization: cpuUtilizationBetween(before, after),
    cpuCount: after.count,
    availableMemoryBytes: Math.min(totalMemoryBytes, Math.max(0, await readAvailableMemory())),
    totalMemoryBytes,
  }
}

/** Reads machine load on demand. It has no timer: an idle host reads nothing. */
export class HostResourceReader {
  private cached: { at: number; value: HostResources } | null = null
  private pending: Promise<HostResources> | null = null

  constructor(
    private readonly sample: () => Promise<HostResources> = sampleHostResources,
    private readonly now: () => number = () => performance.now(),
  ) {}

  read(): Promise<HostResources> {
    if (this.cached && this.now() - this.cached.at < READ_TTL_MS) return Promise.resolve(this.cached.value)
    this.pending ??= this.sample()
      .then((value) => {
        this.cached = { at: this.now(), value }
        return value
      })
      .finally(() => { this.pending = null })
    return this.pending
  }
}
