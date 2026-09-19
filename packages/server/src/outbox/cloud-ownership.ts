/**
 * Whether this host's agent-tool writes of tasks and works belong to the cloud
 * (docs/plans/cloud-service-model.md §16). Set by the runner delivery once the
 * host holds a runner grant for an organization's workspace service, cleared when
 * the link goes; read by the task and work tools before every write. A signed-out
 * or unlinked host applies locally as it always did.
 */

let organizationId: string | null = null

/** The organization whose workspace service owns this host's agent writes, or null when they are the host's own. */
export function cloudOwnedOrganization(): string | null {
  return organizationId
}

export function setCloudOwnedOrganization(next: string | null): void {
  organizationId = next
}
