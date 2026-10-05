import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDeviceDomain } from '@solus/server/devices/device-domain'
import { agentDeviceQuickStart, agentDeviceTargetArgs, deviceCloseAgentTool, deviceInstallAgentTool, deviceListAgentTool, deviceOpenAgentTool, deviceScreenshotAgentTool } from '@solus/server/devices/device-tools'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { SOLUS_AGENT_TOOL_NAMES } from '@solus/contracts/agent-tools'

/**
 * The agent device verbs (P17, P18, P23, S02). Execution rechecks setup and
 * agent access on every call; hiding a tool from the catalog is not the gate.
 */

function context(solusSessionId: string | undefined): AgentToolContext {
  return {
    provider: 'claude-code',
    cwd: '/tmp',
    sessionId: () => 'provider-thread',
    solusSessionId: () => solusSessionId,
    abortSignal: new AbortController().signal,
    parentToolUseId: () => undefined,
    emit: () => {},
  }
}

describe('device agent tools', () => {
  test('the device tools are declared for both providers', () => {
    for (const name of ['device_list', 'device_open', 'device_screenshot', 'device_close', 'device_install'] as const) {
      expect(SOLUS_AGENT_TOOL_NAMES).toContain(name)
    }
  })

  test('every call rechecks device support and agent access', async () => {
    const domain = initDeviceDomain({ publish: () => {}, surfaceRequested: () => {}, root: mkdtempSync(join(tmpdir(), 'solus-device-tools-')) })
    for (const tool of [deviceListAgentTool, deviceOpenAgentTool, deviceScreenshotAgentTool, deviceCloseAgentTool, deviceInstallAgentTool]) {
      const off = await tool.execute({}, context('s1'))
      expect(off.ok).toBe(false)
      expect(off.text).toContain('Device support is off')
    }
    expect(domain.manager.settings().enabled).toBe(false)
    // Setup done, agent access never granted. Written directly so the test
    // starts nothing on the machine running it.
    const root = mkdtempSync(join(tmpdir(), 'solus-device-tools-'))
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ enabled: true, agentAccessEnabled: false }))
    initDeviceDomain({ publish: () => {}, surfaceRequested: () => {}, root })
    const noAgent = await deviceOpenAgentTool.execute({}, context('s1'))
    expect(noAgent.text).toContain('Agent device access is off')
  })

  test('a call outside a Solus session is refused', async () => {
    initDeviceDomain({ publish: () => {}, surfaceRequested: () => {}, root: mkdtempSync(join(tmpdir(), 'solus-device-tools-')) })
    expect((await deviceListAgentTool.execute({}, context(undefined))).text).toContain('Solus session')
  })

  test('open guidance pins the exact executable, device and binding', () => {
    const device = { deviceHostId: 'studio', deviceId: 'AB-12', platform: 'ios' as const, name: 'iPhone 16', version: 'iOS 18.0', booted: true, physical: false }
    expect(agentDeviceTargetArgs(device)).toEqual(['--platform', 'ios', '--udid', 'AB-12'])
    const args = [...agentDeviceTargetArgs(device), '--config', '/data/devices/a b.json', '--session', 'solus-1']
    const text = agentDeviceQuickStart(device, '/data/bin/agent-device', args, 'Studio Mac')
    expect(text).toContain("'/data/devices/a b.json'")
    expect(text).toContain('/data/bin/agent-device snapshot -i')
    expect(text).toContain('Studio Mac')
    expect(agentDeviceTargetArgs({ ...device, platform: 'android', deviceId: 'emulator-5554' })).toEqual(['--platform', 'android', '--serial', 'emulator-5554'])
  })
})
