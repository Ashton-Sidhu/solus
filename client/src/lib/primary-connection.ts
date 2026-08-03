import {
  setActiveServerId,
  upsertServer,
  type SavedServer,
} from '@client-core/server-registry'

/** Activates a primary host by reloading into the normal scoped boot path. */
export function activateServer(server: SavedServer): void {
  upsertServer(server)
  setActiveServerId(server.id)
  location.reload()
}
