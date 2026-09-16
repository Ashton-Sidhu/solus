import { untrack } from "svelte";
import { isSessionBusyStatus } from "@solus/contracts/types";
import type { DesktopUpdateRelease } from "@solus/contracts/desktop-update-types";
import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
import { updatesStore } from "@solus/workspace-ui/contexts";
import { toasts } from "@solus/workspace-ui/lib/toasts";
import type { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";

type DesktopAppCore = ReturnType<typeof createAppCore>;

const UPDATE_TOAST_ID = "desktop-update";

/**
 * The shell's side of desktop updates: the toasts. The store says which prompt
 * is owed; this decides when it is safe to show and shows it. A restart prompt
 * waits until no session on the local host is busy, so an update never
 * interrupts a turn. `docs/plans/desktop-updates.md`.
 */
export function installDesktopUpdates(core: DesktopAppCore): void {
  const { session } = core;
  if (!updatesStore.isAvailable) return;
  updatesStore.start();

  const isLocalHostBusy = $derived(
    Object.values(session.sessions).some(
      (item) => item.run.serverId === LOCAL_SERVER_ID && isSessionBusyStatus(item.status),
    ),
  );

  function showDownloadPrompt(release: DesktopUpdateRelease): void {
    toasts.show({
      id: UPDATE_TOAST_ID,
      message: `Solus ${release.version} is available`,
      description: "Download it now and restart when you are ready.",
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      actions: [
        { label: "Download", onAction: () => void updatesStore.download() },
        { label: "Later", onAction: () => {} },
      ],
    });
  }

  function showRestartPrompt(release: DesktopUpdateRelease): void {
    toasts.show({
      id: UPDATE_TOAST_ID,
      message: `Solus ${release.version} is ready`,
      description: "Restart to finish the update.",
      duration: Number.POSITIVE_INFINITY,
      closeButton: true,
      actions: [
        { label: "Restart", onAction: () => updatesStore.restart() },
        { label: "Later", onAction: () => {} },
      ],
    });
  }

  $effect(() => {
    const prompt = updatesStore.pendingPrompt;
    if (!prompt) return;
    if (prompt === "restart" && isLocalHostBusy) return;
    const release = updatesStore.release;
    if (!release) return;
    untrack(() => {
      updatesStore.markPromptShown(prompt);
      if (prompt === "download") showDownloadPrompt(release);
      else showRestartPrompt(release);
    });
  });

  $effect(() => {
    const outcome = updatesStore.manualCheckOutcome;
    if (!outcome) return;
    const state = updatesStore.state;
    untrack(() => {
      updatesStore.markManualCheckReported();
      if (outcome === "up-to-date") {
        const version = updatesStore.currentVersion;
        toasts.success(version ? `Solus ${version} is up to date` : "Solus is up to date");
      } else if (state.kind === "error") {
        toasts.error("Update check failed", { description: state.message });
      }
    });
  });
}
