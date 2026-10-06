import type { WorkspaceState } from "./workspace-connection-status";

/**
 * What Home shows before it has a thread to list. The action follows the
 * state: a device with no host adds one; a saved host that does not answer is
 * tried again (with its hosts one tap away), never paired a second time.
 */
export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly action: "add-host" | "retry-hosts" | null;
}

export function deriveHomeEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): HomeEmptyState {
  const { catalogState } = props;
  if (!catalogState.hasConnections) {
    return {
      title: "No hosts connected",
      detail: "Add a host to load its projects and start sessions.",
      loading: false,
      action: "add-host",
    };
  }

  if (
    !catalogState.hasReadyEnvironment &&
    !catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "Host unavailable",
      detail:
        catalogState.connectionError ??
        "Your saved host is not answering. Check that Solus is running on it and that this device can reach it.",
      loading: false,
      action: "retry-hosts",
    };
  }

  if (
    (catalogState.hasConnectingEnvironment || catalogState.hasPendingShellSnapshot) &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "Connecting to your host",
      detail: "Loading projects and threads from your saved hosts.",
      loading: true,
      action: null,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: "No projects found",
      detail: "The connected host did not report any projects.",
      loading: false,
      action: null,
    };
  }

  return {
    title: "No threads yet",
    detail: "Create a task to start a new coding session in one of your projects.",
    loading: false,
    action: null,
  };
}
