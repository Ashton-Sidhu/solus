import type { HostResourceReader } from '../../host/host-resources'
import type { ResourceTelemetry } from '../../host/resource-telemetry'
import type { HandlerCtx, SolusServer } from '../server'

export interface HostResourceHandlerDeps {
  reader: HostResourceReader
  telemetry: ResourceTelemetry
}

export function registerHostResourceHandlers(server: SolusServer, deps: HostResourceHandlerDeps): void {
  function requireClientId(ctx: HandlerCtx): string {
    if (!ctx.clientId) throw new Error('Process telemetry requires a connected client')
    return ctx.clientId
  }

  server.register('hostResources', async () => deps.reader.read())
  server.register('hostTelemetrySubscribe', async (_args, ctx) => deps.telemetry.subscribe(requireClientId(ctx)))
  server.register('hostTelemetryUnsubscribe', async (_args, ctx) => { deps.telemetry.unsubscribe(requireClientId(ctx)) })
}
