import { describe, expect, test } from 'bun:test'
import type { DeviceConfigureRequest, DeviceState } from '@solus/contracts/device-types'
import { configureDevices, type DeviceDomain } from '@solus/server/devices/device-domain'

function domainSpy() {
  const calls: string[] = []
  const domain = {
    runs: { dispose: () => { calls.push('dispose') } },
    manager: { configure: async (request: DeviceConfigureRequest) => { calls.push(`configure:${JSON.stringify(request)}`); return {} as DeviceState } },
  }
  // SAFETY: configureDevices reads only `runs` and `manager.configure`.
  return { calls, domain: domain as unknown as DeviceDomain }
}

describe('changing device support', () => {
  test('turning it off ends the device runs first, from Settings or from an agent', async () => {
    // update_config and the deviceConfigure RPC share this path, so an agent
    // that turns devices off leaves no run behind.
    const { calls, domain } = domainSpy()
    await configureDevices(domain, { enabled: false })
    expect(calls).toEqual(['dispose', 'configure:{"enabled":false}'])
  })

  test('any other change leaves the runs alone', async () => {
    const { calls, domain } = domainSpy()
    await configureDevices(domain, { enabled: true, autoShowAgentDevices: false })
    expect(calls).toEqual(['configure:{"enabled":true,"autoShowAgentDevices":false}'])
  })
})
