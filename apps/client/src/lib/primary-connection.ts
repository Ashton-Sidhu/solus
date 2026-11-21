import { setActiveServerId, type KnownHost } from '@solus/client-core/known-host'

/** Used only by HostlessHome: activates a known host by reloading into the
 *  normal scoped boot path. A reload from a page with no workspace loses nothing. */
export function activateServer(server: KnownHost): void {
  setActiveServerId(server.id)
  location.reload()
}
