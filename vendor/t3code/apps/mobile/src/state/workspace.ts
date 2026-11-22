import { useSolusDirectory } from "../solus/runtime";
import { Atom } from "effect/reactivity";

import { environmentShell, environmentShellSummaryAtom } from "./shell";
import { isEnvironmentShellPending, projectWorkspaceState } from "./workspaceModel";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { createWorkspaceConnectionAtoms } from "./workspace-connection-atoms";

export const workspaceConnections = createWorkspaceConnectionAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  networkStatusValueAtom: environmentCatalog.networkStatusValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

// A disconnected environment's retries also leave its shell synchronizing.
const hasSyncingConnectedEnvironmentAtom = Atom.make((get) =>
  get(workspaceConnections.environmentsAtom).some(
    (environment) =>
      environment.isEnabled &&
      environment.connectionState === "connected" &&
      isEnvironmentShellPending(get(environmentShell.stateValueAtom(environment.environmentId))),
  ),
).pipe(Atom.withLabel("mobile:has-syncing-connected-environment"));

export function useWorkspaceEnvironments() {
  return useSolusDirectory().environments;
}

export function useWorkspaceConnectionState() {
  return useSolusDirectory().state;
}

export function useConnectionsReady() {
  return !useSolusDirectory().state.isLoadingConnections;
}

export const workspaceStateAtom = Atom.make((get) =>
  projectWorkspaceState({
    isReady: get(workspaceConnections.isReadyAtom),
    networkStatus: get(environmentCatalog.networkStatusValueAtom),
    environments: get(workspaceConnections.environmentsAtom),
    shellSummary: get(environmentShellSummaryAtom),
    hasSyncingConnectedEnvironment: get(hasSyncingConnectedEnvironmentAtom),
  }),
).pipe(Atom.withLabel("mobile:workspace-state"));

export function useWorkspaceState() {
  return useSolusDirectory();
}
