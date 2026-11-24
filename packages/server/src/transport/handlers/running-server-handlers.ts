import type { RunningServerRegistry } from '../../host/running-servers/registry'
import type { HandlerCtx, SolusServer } from '../server'
import { z } from 'zod'
import { resolveHomePath } from '../../platform/paths'
import { effectivePreviewTunnelEnabled } from '../../host/settings'
import { RunningServerTunnels } from '../../host/running-servers/tunnel'

export function registerRunningServerHandlers(server: SolusServer, registry: RunningServerRegistry, isControlPort: (port: number) => boolean): RunningServerTunnels {
  const tunnels = new RunningServerTunnels(registry, isControlPort, effectivePreviewTunnelEnabled)
  const pathsSchema = z.array(z.string().min(1).max(4096)).max(32)
  function clientId(ctx: HandlerCtx): string {
    if (!ctx.clientId) throw new Error('Running server discovery requires a connected client')
    return ctx.clientId
  }
  server.register('runningServersList', async () => registry.list())
  server.register('runningServersWatch', async ([paths], ctx) => registry.watch(clientId(ctx), pathsSchema.parse(paths ?? []).map(resolveHomePath)))
  server.register('runningServersCheckoutRoots', async ([paths]) => registry.checkoutRoots(pathsSchema.parse(paths)))
  server.register('runningServersUnwatch', async (_args, ctx) => registry.unwatch(clientId(ctx)))
  server.register('runningServerStop', async ([serverId]) => registry.stopServer(serverId))
  server.register('runningServerTunnel', async ([serverId, endpointId], ctx) => tunnels.issue(clientId(ctx), serverId, endpointId))
  server.register('portForwardTunnel', ([port], ctx) => tunnels.issuePort(clientId(ctx), port))
  return tunnels
}
