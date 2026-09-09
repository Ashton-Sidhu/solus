import type { ProjectRef } from "@solus/workspace-ui/contexts/projects/project-catalog";
import type { IpcContext } from "@solus/contracts/types";

/** Transient desktop dialogs retain drafts and focus state across closes. */
export class DesktopDialogs {
  designModeScreenshot = $state<string | null>(null);
  designModeTargetTabId = $state<string | undefined>(undefined);
  directoryPickerOpen = $state(false);
  directoryPickerNewTab = $state(false);
  directoryPickerTargetTabId = $state<string | undefined>(undefined);
  /** Set when the browser was opened from a session draft, which has no tab to
   *  retarget — the chosen directory lands on its run config instead. */
  directoryPickerDraftId = $state<string | undefined>(undefined);
  // Set when a caller names the host to browse — the "Run on" picker and the
  // Open project flow both browse a host no tab points at yet.
  directoryPickerServerIdOverride = $state<string | undefined>(undefined);
  // Only the Run on picker turns a cross-host folder choice into a mandatory
  // session worktree. Opening a remote project uses the normal preference.
  directoryPickerIntent = $state<"dispatch" | "open-project">("open-project");
  // "Choose location…" in the Open project flow borrows the same browser; its
  // selection is handed back to that flow instead of retargeting a tab here.
  directoryPickerForOpenProject = $state(false);
  // "Add project…" in a page's project switcher borrows it too: the folder is
  // recorded as a project so pages can scope to it, and no tab is retargeted.
  directoryPickerForAddProject = $state(false);
  directoryPickerOnProjectAdded = $state<
    ((project: ProjectRef) => void) | undefined
  >(undefined);
  shortcutsModalOpen = $state(false);
  shortcutsActiveScopes = $state<
    import("@solus/workspace-ui/lib/keybindings/types").Scope[]
  >([]);
  commandPaletteOpen = $state(false);
  projectSearchOpen = $state(false);
  hasMountedProjectSearch = $state(false);
  goToFileOpen = $state(false);
  hasMountedGoToFile = $state(false);
  paletteGitTarget = $state<{
    tabId: string;
    ctx: IpcContext;
    projectRoot: string | null;
  } | null>(null);
  hasMountedDirectoryPicker = $state(false);
  hasMountedShortcuts = $state(false);
  // The command palette is keyboard-critical and cheap while hidden. Mount it
  // with the app so the first shortcut never pays component setup work.
  hasMountedCommandPalette = $state(true);
  /** The paste-a-link document importer, opened from the command palette. */
  importDocOpen = $state(false);
  hasMountedAddServer = $state(false);
  hasMountedOpenProject = $state(false);
  hasMountedHostOnboarding = $state(false);
  /** Offered as the prefill when a remote host has no commit identity of its own. */
  localGitIdentity = $state<{ name: string; email: string } | null>(null);
  // When set, the palette opens drilled straight into this sub-page (e.g. the
  // "Review a PR" git action reuses the "Review PR…" page). Cleared once consumed.
  paletteInitialPage = $state<{ id: string; title: string } | null>(null);
}
