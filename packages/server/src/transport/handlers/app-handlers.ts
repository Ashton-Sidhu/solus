import { appCallRequestSchema, appPermissionsUpdateSchema, appRequestSchema, appToolRequestSchema } from '@solus/contracts/apps'
import type { Apps } from '../../apps/apps'
import type { SolusServer } from '../server'

export function registerAppHandlers(server: SolusServer, apps: Apps): void {
  server.register('appRead', ([input], ctx) => apps.read(appRequestSchema.parse(input), ctx))
  server.register('appToolInfo', ([input], ctx) => apps.toolInfo(appToolRequestSchema.parse(input), ctx))
  server.register('appCallTool', ([input], ctx) => apps.callTool(appCallRequestSchema.parse(input), ctx))
  server.register('appPermissionsUpdate', ([input], ctx) => apps.permissionsUpdate(appPermissionsUpdateSchema.parse(input), ctx))
}
