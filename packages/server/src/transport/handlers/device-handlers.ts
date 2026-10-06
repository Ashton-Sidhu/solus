import { z } from 'zod'
import {
  deviceActionRequestSchema,
  deviceCloseRequestSchema,
  deviceConfigureRequestSchema,
  deviceControlRequestSchema,
  deviceInstallRequestSchema,
  deviceBuildImportRequestSchema,
  deviceRunStartRequestSchema,
  deviceOpenRequestSchema,
  deviceScreenshotRequestSchema,
  deviceShutdownRequestSchema,
  deviceTargetSchema,
  deviceToolUpdateRequestSchema,
  sshDeviceHostConfigSchema,
  type DeviceControlHolder,
  type DeviceHostTestResult,
  type SshDeviceHostConfig,
} from '@solus/contracts/device-types'
import { userKey } from '@solus/contracts/user'
import type { HandlerCtx, SolusServer } from '../server'
import type { DeviceDomain } from '../../devices/device-domain'
import { DeviceDomainError } from '../../devices/device-errors'
import { DeviceProjectDetector } from '../../devices/device-project'
import { resolveHomePath } from '../../platform/paths'
import { isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'

/**
 * The device domain's RPC surface (docs/plans/native-devices.md). Handlers
 * validate wire input and pass typed requests to the device manager.
 *
 * Admission (D3): setup methods are host-admin; viewing and control are
 * host-wide; opening and closing a preview also need the named session. A
 * guest admitted through a session share has no host device access.
 */
export function registerDeviceHandlers(
  server: SolusServer,
  deps: {
    domain: DeviceDomain
    testSshHost: (config: SshDeviceHostConfig) => Promise<DeviceHostTestResult>
  },
): void {
  const { manager } = deps.domain

  /** Wire input: the typed argument is still parsed, because a client may send anything. */
  function parse<T, Input>(schema: z.ZodType<T, Input>, value: Input): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new DeviceDomainError('invalid_request', parsed.error.issues[0]?.message ?? 'The device request is invalid.')
    return parsed.data
  }

  function requirePerson(ctx: HandlerCtx): void {
    if (ctx.principal.kind === 'guest') {
      throw new DeviceDomainError('session_forbidden', 'A shared session does not include access to this host\'s devices.')
    }
  }

  function userHolder(ctx: HandlerCtx): DeviceControlHolder & { kind: 'user' } {
    requirePerson(ctx)
    const holder: DeviceControlHolder & { kind: 'user' } = {
      kind: 'user',
      clientId: ctx.clientId,
      label: ctx.actor.user?.displayName ?? ctx.deviceLabel ?? 'Someone',
    }
    if (ctx.actor.user) holder.userId = userKey(ctx.actor.user.id)
    return holder
  }

  server.register('deviceState', (_args, ctx) => { requirePerson(ctx); return manager.state() })
  server.register('deviceList', (_args, ctx) => { requirePerson(ctx); return manager.list() })
  server.register('deviceToolInspect', (_args, ctx) => { requirePerson(ctx); return manager.inspect() })
  server.register('deviceDetail', (args, ctx) => {
    requirePerson(ctx)
    return manager.detail(parse(deviceTargetSchema, args[0]))
  })

  server.register('deviceConfigure', (args) => manager.configure(parse(deviceConfigureRequestSchema, args[0])))
  server.register('deviceHostSave', async (args) => {
    const config = parse(sshDeviceHostConfigSchema, args[0])
    const hosts = manager.settings().sshHosts.filter((host) => host.id !== config.id)
    return manager.saveSshHosts([...hosts, config])
  })
  server.register('deviceHostRemove', async (args) => {
    const deviceHostId = parse(z.string().min(1).max(128), args[0])
    return manager.saveSshHosts(manager.settings().sshHosts.filter((host) => host.id !== deviceHostId))
  })
  server.register('deviceHostTest', (args) => deps.testSshHost(parse(sshDeviceHostConfigSchema, args[0])))
  server.register('deviceToolUpdate', (args) => {
    const request = parse(deviceToolUpdateRequestSchema, args[0])
    return manager.updateTool(request.deviceHostId, request.tool)
  })
  server.register('deviceHostRetry', (args) => manager.retryHost(parse(z.string().min(1).max(128), args[0])))

  server.register('deviceOpen', (args, ctx) => {
    requirePerson(ctx)
    return manager.open(parse(deviceOpenRequestSchema, args[0]), 'user')
  })
  server.register('deviceClose', (args, ctx) => {
    requirePerson(ctx)
    manager.close(parse(deviceCloseRequestSchema, args[0]))
  })
  server.register('deviceShutdown', async (args, ctx) => {
    const request = parse(deviceShutdownRequestSchema, args[0])
    // Powering off is a mutation: it needs the caller's live control lease.
    manager.control.authorize(request, userHolder(ctx))
    await manager.shutdown(request)
  })

  server.register('deviceAction', (args, ctx) => {
    const request = parse(deviceActionRequestSchema, args[0])
    return manager.action(request, request.action, userHolder(ctx))
  })

  server.register('deviceInstall', async (args, ctx) => {
    const request = parse(deviceInstallRequestSchema, args[0])
    const { build } = await manager.installBuild(request, request.buildId, userHolder(ctx), request.launch ?? true)
    return build
  })

  server.register('deviceBuildImport', async (args) => {
    const request = parse(deviceBuildImportRequestSchema, args[0])
    // A client path is not a real path until it is resolved on this host.
    const path = request.path === '~' ? null : resolveHomePath(request.path)
    if (!path || !isAbsolute(path)) throw new DeviceDomainError('invalid_request', 'Enter the full path of the build on the host.')
    const { path: _path, ...build } = await manager.addBuild(path, request.sessionId ?? '')
    return build
  })
  server.register('deviceBuildDelete', (args) => manager.deleteBuild(parse(z.string().trim().min(1).max(128), args[0])))

  server.register('deviceRunStart', (args, ctx) => {
    const request = parse(deviceRunStartRequestSchema, args[0])
    return deps.domain.runs.start(request, userHolder(ctx))
  })
  server.register('deviceRunCancel', (args, ctx) => {
    requirePerson(ctx)
    deps.domain.runs.cancel(parse(z.string().min(1).max(128), args[0]))
  })
  server.register('deviceRunLog', (args, ctx) => {
    requirePerson(ctx)
    return deps.domain.runs.log(parse(z.string().min(1).max(128), args[0]))
  })

  const projects = new DeviceProjectDetector()
  server.register('deviceProjectDetect', async (args, ctx) => {
    requirePerson(ctx)
    const raw = parse(z.string().trim().min(1).max(4096), args[0])
    // A client path is not a real path until it is resolved on this host.
    const root = raw === '~' ? null : resolveHomePath(raw)
    if (!root || !isAbsolute(root) || !(await stat(root).catch(() => null))?.isDirectory()) {
      return { isMobileApp: false, platforms: [], markers: [] }
    }
    return projects.detect(root)
  })

  server.register('deviceStreamUrl', async (args, ctx) => {
    requirePerson(ctx)
    const target = parse(deviceTargetSchema, args[0])
    const { device } = await manager.resolveDevice(target.deviceHostId, target.deviceId)
    return { path: deps.domain.hubProxy.mint(ctx.clientId, target, device.platform), platform: device.platform }
  })
  server.register('deviceScreenshot', async (args, ctx) => {
    requirePerson(ctx)
    const request = parse(deviceScreenshotRequestSchema, args[0])
    const { png: _png, ...result } = await manager.screenshot(request.deviceHostId, request.deviceId)
    return result
  })

  server.register('deviceControlAcquire', (args, ctx) => {
    const request = parse(deviceControlRequestSchema, args[0])
    return manager.acquireControl(request, userHolder(ctx))
  })
  server.register('deviceControlRelease', (args, ctx) => {
    manager.releaseControl(parse(deviceTargetSchema, args[0]), userHolder(ctx))
  })
  server.register('deviceControlResume', (args, ctx) => {
    requirePerson(ctx)
    manager.control.resumeAgent(parse(deviceTargetSchema, args[0]))
  })
}
