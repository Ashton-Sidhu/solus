import { spawn } from 'node:child_process'
import { getCliEnv } from '../cli-env'
import type { WatchProbe, WatchProbeResult } from '@solus/contracts/watch-types'
import { OUTPUT_TAIL_CHARS } from './watch-rules'

/**
 * Run one probe command on the host and keep the last part of its output.
 *
 * The command runs in its own process group so a timeout stops everything it
 * started, not only the shell. Stdin is closed: a probe that waits for input
 * would otherwise wait out its whole timeout.
 */
export function runProbe(probe: WatchProbe, cwd: string): Promise<WatchProbeResult> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let timedOut = false
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_TAIL_CHARS * 2) output = output.slice(-OUTPUT_TAIL_CHARS)
    }
    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result: WatchProbeResult = {
        exitCode,
        outputTail: output.slice(-OUTPUT_TAIL_CHARS),
        at: new Date().toISOString(),
      }
      if (error) result.error = error
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('/bin/sh', ['-c', probe.command], {
        cwd,
        env: getCliEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (error) {
      resolve({
        exitCode: null,
        outputTail: '',
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, probe.timeoutSeconds * 1000)
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => {
      if (timedOut) finish(null, `Timed out after ${probe.timeoutSeconds}s`)
      else finish(code)
    })
  })
}
