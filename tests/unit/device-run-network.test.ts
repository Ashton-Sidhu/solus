import { expect, test } from 'bun:test'
import type { DeviceSummary } from '@solus/contracts/device-types'
import { connectDevelopmentDevice, disconnectDevelopmentDevice } from '@solus/server/devices/device-run-network'
import type { DeviceCommandRunner } from '@solus/server/devices/device-process'

const device: DeviceSummary = { deviceHostId: 'local', deviceId: 'phone', platform: 'android', name: 'Phone', version: 'Android', booted: true, physical: true }

test('a test creates and removes only its own Android connection', async () => {
  let mapping = ''
  const calls: string[] = []
  const run: DeviceCommandRunner = async (_command, args, options) => {
    expect(options?.env?.PATH).toBe('sdk-tools')
    calls.push(args.join(' '))
    if (args.includes('--list')) return { code: 0, stdout: mapping, stderr: '' }
    mapping = args.includes('--remove') ? '' : 'phone tcp:8081 tcp:8081\n'
    return { code: 0, stdout: '', stderr: '' }
  }
  const connection = await connectDevelopmentDevice(device, run, { PATH: 'sdk-tools' })
  expect(connection).toEqual({ deviceId: 'phone' })
  await disconnectDevelopmentDevice(connection!, run, { PATH: 'sdk-tools' })
  expect(calls.at(-1)).toBe('-s phone reverse --remove tcp:8081')
  expect(mapping).toBe('')
})

test('an existing matching connection is used without claiming ownership', async () => {
  const calls: string[] = []
  const run: DeviceCommandRunner = async (_command, args) => {
    calls.push(args.join(' '))
    return { code: 0, stdout: 'phone tcp:8081 tcp:8081\n', stderr: '' }
  }
  expect(await connectDevelopmentDevice(device, run, {})).toBeNull()
  expect(calls).toEqual(['-s phone reverse --list'])
})

test('a connection to another server is never replaced or removed', async () => {
  const calls: string[] = []
  const run: DeviceCommandRunner = async (_command, args) => {
    calls.push(args.join(' '))
    return { code: 0, stdout: 'phone tcp:9090 tcp:8081\nphone tcp:8081 tcp:9090\n', stderr: '' }
  }
  await expect(connectDevelopmentDevice(device, run, {})).rejects.toThrow('another server')
  await disconnectDevelopmentDevice({ deviceId: 'phone' }, run, {})
  expect(calls).toEqual(['-s phone reverse --list', '-s phone reverse --list'])
})
