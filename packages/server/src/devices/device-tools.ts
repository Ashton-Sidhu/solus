import { z } from 'zod'
import { LOCAL_DEVICE_HOST_ID, type DevicePlatform, type DeviceSummary } from '@solus/contracts/device-types'
import { agentToolImage, type AgentTool, type AgentToolContext, type AgentToolResult } from '../execution/agents/tools/agent-tool'
import { deviceDomain, type DeviceDomain } from './device-domain'
import { agentSessionName } from './device-agent-bridge'
import { agentDeviceConfigPath, ensureAgentDeviceShim, removeAgentDeviceConfig, writeAgentDeviceConfig } from './device-agent-cli'
import { deviceErrorDetail } from './device-errors'
import { resolveNodeRuntime, runDeviceCommand } from './device-process'
import { isAbsolute, resolve } from 'node:path'
import { deviceBuildFits } from '@solus/contracts/device-types'
import { resolveHomePath } from '../platform/paths'

/**
 * The agent's device verbs (plan 016, P17): list, open, screenshot, close,
 * and install.
 * Driving happens through the bound `agent-device` CLI that `device_open`
 * returns; wrapping its commands here would only lag behind it. Every call
 * rechecks that device support and agent access are on, and works only in
 * the calling session. Adapted from T3 Code's device toolkit (MIT,
 * pingdotgg/t3code@43bd667, apps/server/src/mcp/toolkits/device).
 */

const TOOL_DEADLINE_MS = 4 * 60_000

type Fields = NonNullable<AgentTool['inputFields']>

function deviceTool<F extends Fields>(spec: {
  name: string
  description: string
  inputFields: F
  execute: (input: z.output<z.ZodObject<F>>, context: AgentToolContext, domain: DeviceDomain, sessionId: string) => Promise<AgentToolResult>
}): AgentTool {
  return {
    name: spec.name,
    description: spec.description,
    inputFields: spec.inputFields,
    requiresApproval: false,
    execute: async (input, context) => {
      const domain = deviceDomain()
      const sessionId = context.solusSessionId()
      if (!domain) return { ok: false, text: 'This Solus host has no device support.' }
      if (!sessionId) return { ok: false, text: 'Device tools need a Solus session.' }
      const settings = domain.manager.settings()
      if (!settings.enabled) return { ok: false, text: 'Device support is off. Ask the user to turn it on in Devices setup.' }
      if (!settings.agentAccessEnabled) return { ok: false, text: 'Agent device access is off. The user can turn it on in Devices setup; manual previews still work.' }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // SAFETY: executeAgentTool parsed the call against these exact fields.
        const parsed = input as z.output<z.ZodObject<F>>
        return await Promise.race([
          spec.execute(parsed, context, domain, sessionId),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${spec.name} did not finish within ${TOOL_DEADLINE_MS / 60_000} minutes.`)), TOOL_DEADLINE_MS)
          }),
        ])
      } catch (error) {
        return { ok: false, text: deviceErrorDetail(error) }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Flags that pin every agent-device command to one device. */
export function agentDeviceTargetArgs(device: DeviceSummary): string[] {
  return device.platform === 'ios'
    ? ['--platform', 'ios', '--udid', device.deviceId]
    : ['--platform', 'android', '--serial', device.deviceId]
}

const shellWord = (value: string) => (/^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`)

/** The just-in-time guide `device_open` returns. Only sessions that open a device pay for it. */
export function agentDeviceQuickStart(device: DeviceSummary, command: string, args: string[], hostLabel: string): string {
  const exe = shellWord(command)
  const target = args.map(shellWord).join(' ')
  return [
    `The user can watch ${device.name} (${device.version}) on ${hostLabel} in the Devices pane.`,
    `Drive it with this exact executable; login shells may reset PATH. Always pass: ${target}`,
    'Typical loop:',
    `  ${exe} open <bundle-or-package-id> ${target}`,
    `  ${exe} snapshot -i ${target}            # accessibility tree with @eN refs`,
    `  ${exe} click @e3 ${target}`,
    `  ${exe} fill @e5 "text" ${target}`,
    `  ${exe} install <app> <path-to-.app-or-.apk> ${target}`,
    'Use device_screenshot to see the screen. Prefer snapshot refs over coordinates; refs from an old snapshot may be stale.',
    `Run ${exe} help for guides. simctl, adb and xcrun remain available for anything it does not cover.`,
    device.platform === 'ios'
      ? 'First use builds an XCTest runner and can take a couple of minutes.'
      : 'The Android snapshot helper installs itself on first use.',
    'If the user takes control, device commands fail with a paused message: stop driving the device and wait, or open another available simulator.',
    'For a remote device host, build and install the app there yourself, and make Metro reachable from that machine; Solus does not rewrite localhost.',
  ].join('\n')
}

function pickDevice(devices: DeviceSummary[], input: { deviceId?: string | undefined; platform?: DevicePlatform | undefined; deviceHostId?: string | undefined }): DeviceSummary {
  const deviceHostId = input.deviceHostId ?? LOCAL_DEVICE_HOST_ID
  if (input.deviceId) {
    const match = devices.find((device) => device.deviceHostId === deviceHostId && device.deviceId === input.deviceId)
    if (!match) throw new Error(`No device ${input.deviceId} on host ${deviceHostId}. Call device_list for current ids.`)
    return match
  }
  const candidates = devices.filter((device) => device.deviceHostId === deviceHostId && (!input.platform || device.platform === input.platform))
  if (candidates.length === 0) throw new Error(input.platform ? `No ${input.platform} devices on host ${deviceHostId}. Call device_list to see why.` : 'No simulators or emulators were found. Call device_list to see why.')
  if (!input.platform && new Set(candidates.map((device) => device.platform)).size > 1) {
    throw new Error('Both iOS and Android devices are available; pass platform or deviceId.')
  }
  return candidates.find((device) => device.booted) ?? candidates[0]!
}

export const deviceListAgentTool = deviceTool({
  name: 'device_list',
  description: 'List iOS Simulators, Android Emulators and connected iPhones, iPads and Android phones on this host and its SSH device hosts, which platforms each host can run, who controls each device, and which devices are open in this session. Call before device_open or device_install when you do not know a device id.',
  inputFields: { deviceHostId: z.string().max(128).optional().describe('Limit to one device host. Defaults to all hosts.') },
  execute: async (input, _context, domain, sessionId) => {
    const state = await domain.manager.list()
    const hostId = input.deviceHostId
    const lines: string[] = []
    for (const host of state.hosts.filter((entry) => !hostId || entry.deviceHostId === hostId)) {
      const status = state.hostStatuses.find((entry) => entry.deviceHostId === host.deviceHostId)
      lines.push(`Host ${host.deviceHostId} (${host.label}): ${status?.status ?? 'idle'}${status?.detail ? ` — ${status.detail}` : ''}`)
      for (const platform of host.platforms) lines.push(`  ${platform.platform}: ${platform.available ? 'available' : `unavailable — ${platform.reason ?? 'unknown'}`}`)
    }
    const devices = state.devices.filter((device) => !hostId || device.deviceHostId === hostId)
    lines.push(devices.length ? 'Devices:' : 'No devices found.')
    for (const device of devices) {
      const control = state.controls.find((entry) => entry.deviceHostId === device.deviceHostId && entry.deviceId === device.deviceId)
      const open = state.previews.some((preview) => preview.sessionId === sessionId && preview.deviceHostId === device.deviceHostId && preview.deviceId === device.deviceId)
      const usedElsewhere = state.previews.some((preview) => preview.sessionId !== sessionId && preview.deviceHostId === device.deviceHostId && preview.deviceId === device.deviceId)
      const kind = device.physical ? `connected device${device.unavailableReason ? ` (not ready: ${device.unavailableReason})` : ''}` : device.booted ? 'booted' : 'stopped'
      lines.push(`  ${device.deviceId} | ${device.platform} | ${device.name} | ${device.version} | host ${device.deviceHostId} | ${kind}${open ? ' | open in this session' : ''}${usedElsewhere ? ' | used by another session' : ''}${control?.lease ? ` | controlled by ${control.lease.holder.label}` : ''}${control?.agentPaused ? ' | agent actions paused' : ''}`)
    }
    return { ok: true, text: lines.join('\n') }
  },
})

export const deviceOpenAgentTool = deviceTool({
  name: 'device_open',
  description: 'Open a simulator or emulator in this session: boots it if needed and shows it in the Devices pane so the user can watch. Returns the exact agent-device command and flags bound to this device; drive it with that CLI.',
  inputFields: {
    deviceId: z.string().max(256).optional().describe('Simulator UDID or emulator serial from device_list. Omit to use the booted device for the platform.'),
    platform: z.enum(['ios', 'android']).optional().describe('Required when deviceId is omitted and both platforms are available.'),
    deviceHostId: z.string().max(128).optional().describe('Device host from device_list. Defaults to local.'),
  },
  execute: async (input, context, domain, sessionId) => {
    const { manager, toolchain } = domain
    const state = await manager.list()
    const target = pickDevice(state.devices, input)
    // Agent tools must be running before the device is booted or bound.
    await manager.agentReadiness(target.deviceHostId)
    const preview = await manager.open({ sessionId, deviceHostId: target.deviceHostId, deviceId: target.deviceId, platform: target.platform }, 'agent')
    const device = manager.findDevice(preview.deviceHostId, preview.deviceId) ?? target
    const label = `${context.provider === 'codex' ? 'Codex' : 'Claude'} agent`
    const agentSession = agentSessionName(sessionId, device.deviceHostId, device.deviceId)
    const bridgeUrl = await domain.bridge.start()
    const token = domain.bridge.bind({ sessionId, deviceHostId: device.deviceHostId, deviceId: device.deviceId, platform: device.platform, agentSession, label })
    const configPath = agentDeviceConfigPath(domain.agentConfigDir, agentSession)
    await writeAgentDeviceConfig(configPath, bridgeUrl, token)
    // The CLI runs on this Solus host even when the device is on an SSH host.
    const node = await resolveNodeRuntime(process.env, runDeviceCommand)
    if ('error' in node) throw new Error(node.error)
    const cli = await toolchain.ensure('agent')
    const command = await ensureAgentDeviceShim({ dir: domain.agentConfigDir, nodePath: node.nodePath, entryPath: cli.entryPath })
    const args = [...agentDeviceTargetArgs(device), '--config', configPath, '--session', agentSession]
    const hostLabel = state.hosts.find((host) => host.deviceHostId === device.deviceHostId)?.label ?? device.deviceHostId
    return {
      ok: true,
      text: [
        `Opened ${device.name} (${device.deviceId}) on ${hostLabel}.`,
        `Command: ${command}`,
        `Flags: ${args.map(shellWord).join(' ')}`,
        '',
        agentDeviceQuickStart(device, command, args, hostLabel),
      ].join('\n'),
    }
  },
})

export const deviceScreenshotAgentTool = deviceTool({
  name: 'device_screenshot',
  description: 'Capture the current screen of a device open in this session as an image you can see. For taps and typing use the agent-device CLI from device_open.',
  inputFields: {
    deviceId: z.string().max(256).optional().describe('Omit to use the device most recently opened in this session.'),
    deviceHostId: z.string().max(128).optional(),
  },
  execute: async (input, _context, domain, sessionId) => {
    const previews = domain.manager.previewsForSession(sessionId)
    const target = input.deviceId
      ? { deviceHostId: input.deviceHostId ?? LOCAL_DEVICE_HOST_ID, deviceId: input.deviceId }
      : previews.filter((preview) => !input.deviceHostId || preview.deviceHostId === input.deviceHostId).at(-1)
    if (!target) return { ok: false, text: 'No device is open in this session. Call device_open first.' }
    const shot = await domain.manager.screenshot(target.deviceHostId, target.deviceId)
    const image = agentToolImage(shot.png)
    const result: AgentToolResult = {
      ok: true,
      text: `Screenshot of ${shot.device.name} (${shot.device.deviceId}), ${shot.width}×${shot.height}. Saved as asset ${shot.assetId}.${image ? '' : ' The image is too large to attach; open the asset instead.'}`,
    }
    if (image) result.image = image
    return result
  },
})

export const deviceCloseAgentTool = deviceTool({
  name: 'device_close',
  description: 'Remove a device from this session\'s Devices pane. Pass shutdown=true to also power it off, which is refused while another session uses it.',
  inputFields: {
    deviceId: z.string().max(256).optional().describe('Omit to close every device in this session.'),
    deviceHostId: z.string().max(128).optional(),
    shutdown: z.boolean().optional().describe('Also power the simulator or emulator off. Defaults to false.'),
  },
  execute: async (input, context, domain, sessionId) => {
    const { manager } = domain
    const closing = manager.previewsForSession(sessionId).filter((preview) =>
      (!input.deviceHostId || preview.deviceHostId === input.deviceHostId) && (!input.deviceId || preview.deviceId === input.deviceId))
    if (closing.length === 0) return { ok: true, text: 'No matching device is open in this session.' }
    if (input.shutdown) {
      const others = manager.state().previews.filter((preview) => preview.sessionId !== sessionId
        && closing.some((item) => item.deviceHostId === preview.deviceHostId && item.deviceId === preview.deviceId))
      if (others.length > 0) return { ok: false, text: 'Another session is using this device, so it was not powered off. Close it here without shutdown.' }
    }
    manager.close({ sessionId, deviceHostId: input.deviceHostId, deviceId: input.deviceId })
    for (const preview of closing) await removeAgentDeviceConfig(agentDeviceConfigPath(domain.agentConfigDir, agentSessionName(sessionId, preview.deviceHostId, preview.deviceId)))
    if (!input.shutdown) return { ok: true, text: `Closed ${closing.length} device${closing.length === 1 ? '' : 's'}. They keep running.` }
    const holder = { kind: 'agent' as const, sessionId, label: `${context.provider === 'codex' ? 'Codex' : 'Claude'} agent` }
    for (const preview of closing) {
      const lease = manager.control.acquireForAgent(preview, holder)
      const end = manager.control.begin(preview, lease.generation, holder)
      try {
        await manager.shutdown(preview)
      } finally {
        end()
      }
    }
    return { ok: true, text: `Closed and powered off ${closing.length} device${closing.length === 1 ? '' : 's'}.` }
  },
})

export const deviceInstallAgentTool = deviceTool({
  name: 'device_install',
  description: 'Hand an app build to Solus and install it. Pass the build output: an iOS .app bundle (a simulator build, or a device build signed for development) or an Android .apk. With deviceId, installs it on that simulator, emulator or connected phone or iPad and opens it; a simulator or emulator boots if needed and is shown beside the conversation. Every build also appears in Solus under Devices → Builds, where the user can install it on a device or download an APK straight to their Android phone. Build first (xcodebuild, gradle, expo run); Solus does not build or sign.',
  inputFields: {
    path: z.string().min(1).max(4096).describe('The .app bundle or .apk file. Relative paths resolve against your working directory.'),
    deviceId: z.string().max(256).optional().describe('Device from device_list. Omit to only record the build for the user.'),
    deviceHostId: z.string().max(128).optional().describe('Device host from device_list. Defaults to local; builds install only on devices of the Solus host itself.'),
    appId: z.string().max(255).optional().describe('Bundle id or package name. Needed to open an Android app after install; read from Info.plist for iOS.'),
    launch: z.boolean().optional().describe('Open the app after install. Defaults to true.'),
  },
  execute: async (input, context, domain, sessionId) => {
    const { manager } = domain
    const expanded = resolveHomePath(input.path)
    const path = isAbsolute(expanded) ? expanded : resolve(resolveHomePath(context.cwd), expanded)
    const build = await manager.addBuild(path, sessionId, input.appId)
    // The build is published to the conversation here, not left to the
    // agent's reply: the person who asked for it gets its install buttons at
    // once, even when the install below fails.
    const announce = (installedOn: string | null) => context.emit({
      type: 'device_build_ready',
      build: { buildId: build.buildId, name: build.name, platform: build.platform, appId: build.appId, installedOn },
    })
    const recorded = `Recorded ${build.name} (${build.platform}${build.runsOn === 'any' ? '' : `, ${build.runsOn} build`}${build.appId ? `, ${build.appId}` : ''}) as ${build.buildId}. The user can find it under Devices → Builds${build.platform === 'android' ? ' and download it to an Android phone there' : ''}.`
    if (!input.deviceId) {
      announce(null)
      const state = await manager.list()
      const fits = state.devices.filter((device) => deviceBuildFits(build, device.physical ? device : { ...device, booted: true }).fits)
      return { ok: true, text: [recorded, fits.length ? `Devices that can run it: ${fits.map((device) => `${device.name} (${device.deviceId}${device.physical || device.booted ? '' : ', stopped'})`).join(', ')}. Pass one as deviceId to install and show it.` : 'No device on this host can run it.'].join('\n') }
    }
    let target = { deviceHostId: input.deviceHostId ?? LOCAL_DEVICE_HOST_ID, deviceId: input.deviceId }
    const holder = { kind: 'agent' as const, sessionId, label: `${context.provider === 'codex' ? 'Codex' : 'Claude'} agent` }
    let installed: Awaited<ReturnType<typeof manager.installBuild>>
    try {
      // A simulator or emulator opens beside the conversation (booting if it
      // is stopped), so the person sees the app the moment it launches.
      const chosen = (await manager.resolveDevice(target.deviceHostId, target.deviceId)).device
      if (!chosen.physical) {
        const preview = await manager.open({ sessionId, deviceHostId: chosen.deviceHostId, deviceId: chosen.deviceId, platform: chosen.platform }, 'agent')
        target = { deviceHostId: preview.deviceHostId, deviceId: preview.deviceId }
      }
      const lease = manager.control.acquireForAgent(target, holder)
      installed = await manager.installBuild(target, build.buildId, lease.generation, holder, input.launch ?? true)
    } catch (error) {
      announce(null)
      throw error
    }
    const { device, launched } = installed
    announce(device.name)
    const opened = launched ? ' and opened it' : build.appId ? '' : '. Pass appId to open it after install'
    return { ok: true, text: `${recorded}\nInstalled it on ${device.name}${opened}.` }
  },
})
