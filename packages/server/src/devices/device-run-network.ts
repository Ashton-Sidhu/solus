import type { DeviceSummary } from '@solus/contracts/device-types'
import { DeviceDomainError } from './device-errors'
import type { DeviceCommandRunner } from './device-process'

export interface DeviceDevConnection { deviceId: string }

function reverseDestination(text: string): string | null {
  for (const line of text.split('\n')) {
    const words = line.trim().split(/\s+/)
    const [source, destination] = words.slice(-2)
    if (source === 'tcp:8081') return destination ?? null
  }
  return null
}

/** A test can use an existing matching connection, but cannot replace another one. */
export async function connectDevelopmentDevice(device: DeviceSummary, run: DeviceCommandRunner, env: NodeJS.ProcessEnv): Promise<DeviceDevConnection | null> {
  if (device.platform !== 'android') return null
  const before = await run('adb', ['-s', device.deviceId, 'reverse', '--list'], { timeoutMs: 10_000, env })
  if (before.code !== 0) throw new DeviceDomainError('command_failed', before.stderr || 'Could not check this device connection.')
  const existing = reverseDestination(before.stdout)
  if (existing === 'tcp:8081') return null
  if (existing) throw new DeviceDomainError('control_busy', 'This device already connects port 8081 to another server. Keep that connection, or remove it before this test.')
  const result = await run('adb', ['-s', device.deviceId, 'reverse', 'tcp:8081', 'tcp:8081'], { timeoutMs: 10_000, env })
  if (result.code !== 0) throw new DeviceDomainError('command_failed', result.stderr || 'Could not connect this device to the dev server.')
  return { deviceId: device.deviceId }
}

/** Remove only the mapping this run created, and only while it still matches. */
export async function disconnectDevelopmentDevice(connection: DeviceDevConnection, run: DeviceCommandRunner, env: NodeJS.ProcessEnv): Promise<void> {
  const current = await run('adb', ['-s', connection.deviceId, 'reverse', '--list'], { timeoutMs: 10_000, env })
  if (current.code !== 0 || reverseDestination(current.stdout) !== 'tcp:8081') return
  const removed = await run('adb', ['-s', connection.deviceId, 'reverse', '--remove', 'tcp:8081'], { timeoutMs: 10_000, env })
  if (removed.code !== 0) throw new DeviceDomainError('command_failed', removed.stderr || 'Could not remove the test connection.')
}
