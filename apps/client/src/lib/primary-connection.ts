import {
  setActiveServerId,
  upsertServer,
  type SavedServer,
} from '@solus/client-core/server-registry'

/** Used only by HostlessHome: activates a host by reloading into the normal
 *  scoped boot path. A reload from a page with no workspace loses nothing. */
export function activateServer(server: SavedServer): void {
  upsertServer(server)
  setActiveServerId(server.id)
  location.reload()
}
