import type { IpcContext } from "@solus/contracts/types";

/** Transient desktop dialogs retain drafts and focus state across closes. */
export class DesktopDialogs {
  designModeScreenshot = $state<string | null>(null);
  designModeTargetTabId = $state<string | undefined>(undefined);
  shortcutsModalOpen = $state(false);
  shortcutsActiveScopes = $state<
    import("@solus/workspace-ui/lib/keybindings/types").Scope[]
  >([]);
  commandPaletteOpen = $state(false);
  projectSearchOpen = $state(false);
  goToFileOpen = $state(false);
  paletteGitTarget = $state<{
    tabId: string;
    ctx: IpcContext;
    projectRoot: string | null;
  } | null>(null);
  /** Set when the app is idle: mounts the dialogs a keystroke or Home can summon
   *  (go to file, find in files, open project, folder picker) before their first open. */
  hasWarmedDialogs = $state(false);
  /** The paste-a-link document importer, opened from the command palette. */
  importDocOpen = $state(false);
  hasMountedShareDialog = $state(false);
  /** Offered as the prefill when a remote host has no commit identity of its own. */
  localGitIdentity = $state<{ name: string; email: string } | null>(null);
  // When set, the palette opens drilled straight into this sub-page (e.g. the
  // "Review a PR" git action reuses the "Review PR…" page). Cleared once consumed.
  paletteInitialPage = $state<{ id: string; title: string } | null>(null);
}
