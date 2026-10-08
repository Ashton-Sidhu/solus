import { hosts } from '../hosts/hosts.svelte'
import { serversStore } from '../connections/servers.store.svelte'
import { projectsStore } from './projects.store.svelte'
import { workspaceProjectsStore } from './workspace-projects.store.svelte'
import { isSolusApiId } from '@solus/contracts/uplink'

/**
 * Keep the project directory current for the life of the app
 * (docs/plans/project-model.md): each execution host lists its checkouts and
 * names their repositories, and each workspace service lists the
 * organization's projects. Desktop and web call this once at boot.
 */
export function listenForProjectDirectory(): () => void {
  const unsubCheckouts = projectsStore.listen((serverId) => hosts.hasExecution(serverId) && !isSolusApiId(serverId))
  const unsubCloud = workspaceProjectsStore.listen((serverId) => isSolusApiId(serverId))
  return () => {
    unsubCheckouts()
    unsubCloud()
  }
}
