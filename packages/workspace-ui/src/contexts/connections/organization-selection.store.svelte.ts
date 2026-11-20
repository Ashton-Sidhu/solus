import { hostCatalog } from '@solus/client-core/host-catalog'
import { windowOrganizationSelection, type SelectableWorkspace } from '@solus/client-core/organization-selection'

/**
 * The organization this window works in (docs/plans/organization-scope.md §2):
 * one reactive fact, read by every list store that filters what the window
 * shows beside Local. Kept apart from `serversStore` so a store that only needs
 * the filter does not depend on connections, discovery, and the directory.
 * `serversStore.selectOrganization` is the command that changes it.
 */
class OrganizationSelectionStore {
  activeOrganizationId = $state<string | null>(windowOrganizationSelection.reconcile(hostCatalog.workspaces()))

  constructor() {
    windowOrganizationSelection.subscribe((organizationId) => { this.activeOrganizationId = organizationId })
  }

  reconcile(workspaces: readonly SelectableWorkspace[]): boolean {
    const previous = this.activeOrganizationId
    windowOrganizationSelection.reconcile(workspaces)
    return previous !== this.activeOrganizationId
  }
}

export const organizationSelection = new OrganizationSelectionStore()
