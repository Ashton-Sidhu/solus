import { Building2 as OrganizationIcon } from "@lucide/svelte";
import type { Command } from "@solus/workspace-ui/components/command-palette/lib/commands";
import { newChatCommand } from "@solus/workspace-ui/components/command-palette/lib/new-chat-command";
import { workReviewPaletteCommands } from "@solus/workspace-ui/components/work/lib/work-review-commands";
import { saveFileAsWorkCommands } from "@solus/workspace-ui/components/files/lib/save-file-as-work";
import { artifactsPaletteCommands } from "@solus/workspace-ui/components/session/artifacts/lib/artifacts-commands";
import { updateAllPaletteCommands } from "@solus/workspace-ui/contexts/updates/update-all-commands";
import { addOverSshPaletteCommand } from "@solus/workspace-ui/components/servers/lib/add-over-ssh-commands";
import { addWslDistroPaletteCommands } from "@solus/workspace-ui/components/servers/lib/add-wsl-distro-commands";
import { deviceCommands } from "@solus/workspace-ui/components/devices/lib/device-entry";
import { sidebarViewCommand } from "@solus/workspace-ui/components/session/lib/sidebar-view-command";
import { settingsOwnerCommands, webhookCommands } from "@solus/workspace-ui/components/settings/lib/settings-commands";
import { browserRecordingCommands, focusLeadingComposer } from "@solus/workspace-ui/components/browser/lib/recording-actions";
import type { createProjectPicker } from "@solus/workspace-ui/components/servers/project-picker.svelte";
import { hostUpdatesStore } from "@solus/workspace-ui/contexts/updates/host-updates.store.svelte";
import { comboHint } from "@solus/workspace-ui/lib/keybindings/manifest";
import { serversStore, sharesStore, type ShareDialogTarget, type WorkspaceContext } from "@solus/workspace-ui/contexts";

/** What the web palette's commands act on. Getters, so the palette reads them live. */
export interface WebPaletteDeps {
  session: WorkspaceContext;
  settings: Parameters<typeof sidebarViewCommand>[0];
  projectPicker: ReturnType<typeof createProjectPicker>;
  composerSourceId: () => string | undefined;
  shareTarget: () => ShareDialogTarget | null;
  showShortcuts: () => void;
}

/**
 * The web shell's application commands. They load with the command palette,
 * after the first paint, not with the workspace: their modules reach SSH, WSL,
 * device, and settings code the first screen does not use. The web shell owns
 * its commands just as it owns its keybindings; desktop-only commands remain in
 * the desktop shell's richer palette.
 */
export function webPaletteCommands(deps: WebPaletteDeps): Command[] {
  const { session } = deps;
  const shareTarget = deps.shareTarget();
  return [
  ...workReviewPaletteCommands(session),
  ...saveFileAsWorkCommands(session),
  ...(shareTarget ? [{
    id: "share-session", label: "Share…", group: "General",
    hint: comboHint("global.share"), keywords: ["share", "access", "link", "team", "guest"],
    run: () => sharesStore.open(shareTarget),
  }] : []),
  ...(serversStore.organizations.length > 0 ? [{
    id: "switch-organization", label: "Switch organization…", group: "General", icon: OrganizationIcon,
    hint: comboHint("global.switch-organization"), keywords: ["organization", "org", "team", "workspace", "cloud"],
    children: serversStore.organizations.map((organization) => ({
      id: `switch-organization:${organization.organizationId}`,
      label: organization.name,
      group: "Organizations",
      icon: OrganizationIcon,
      hint: organization.isActive ? "Active" : organization.hostRules.allowsPersonalHosts ? undefined : "Personal computers not allowed",
      keywords: ["organization", "org", organization.organizationId],
      run: () => serversStore.selectOrganization(organization.organizationId),
    })),
  }] : []),
  {
    id: 'check-for-updates', label: 'Check for updates', group: 'General',
    hint: comboHint('global.check-for-updates'), keywords: ['update', 'version', 'provider'],
    run: () => void hostUpdatesStore.checkAll(),
  },
  ...updateAllPaletteCommands(),
  addOverSshPaletteCommand(),
  ...addWslDistroPaletteCommands(() => session.showSettings("api-access", "palette")),
  {
    id: "open-project",
    label: "Open project…",
    group: "General",
    hint: comboHint("global.select-project"),
    keywords: ["folder", "directory", "repository", "host"],
    run: () => deps.projectPicker.startOpenProject({ sourceId: deps.composerSourceId() }),
  },
  {
    id: "new-project",
    label: "New project…",
    group: "General",
    keywords: ["create", "folder", "start", "empty", "git init", "website", "app"],
    run: () => deps.projectPicker.startOpenProject({ sourceId: deps.composerSourceId(), source: "new" }),
  },
  {
    id: "new-session",
    label: "New session",
    group: "General",
    hint: comboHint("global.new-session"),
    keywords: ["create", "chat", "tab"],
    run: () => session.drafts.openSessionDraft({ freshTask: true, via: "palette" }),
  },
  {
    id: "new-session-in-task",
    label: "New session in task",
    group: "General",
    hint: comboHint("global.new-session-in-task"),
    keywords: ["create", "chat", "tab", "task"],
    run: () => session.drafts.openSessionDraft({ via: "palette" }),
  },
  {
    id: "new-session-without-task",
    label: "New session without task",
    group: "General",
    hint: comboHint("global.new-session-without-task"),
    keywords: ["create", "chat", "tab", "no task"],
    run: () =>
      session.drafts.openSessionDraft({ withoutTask: true, via: "palette" }),
  },
  newChatCommand(session),
  {
    id: "workspace",
    label: "Open workspace",
    group: "View",
    hint: comboHint("global.toggle-workspace"),
    keywords: ["works", "documents", "folio"],
    run: () => session.toggleFolio("palette"),
  },
  {
    id: "tasks",
    label: "Open tasks",
    group: "View",
    keywords: ["board", "todo", "issues"],
    run: () => session.openTasks(),
  },
  {
    id: "pull-requests",
    label: "Open pull requests",
    group: "View",
    keywords: ["pr", "review", "github"],
    run: () => session.openPrs(),
  },
  {
    id: "notifications",
    label: "Open notifications",
    group: "View",
    hint: comboHint("global.toggle-notifications"),
    keywords: ["inbox", "assigned", "review request", "mentions", "alerts"],
    run: () => session.openNotifications("palette"),
  },
  {
    id: "automations",
    label: "Open automations",
    group: "View",
    keywords: ["schedule", "recurring", "cron"],
    run: () => session.openAutomations(),
  },
  {
    id: "browser",
    label: "Open browser",
    group: "View",
    keywords: ["web", "viewport", "device"],
    run: () => session.openBrowser(),
  },
  ...browserRecordingCommands(() => focusLeadingComposer(session.router)),
  ...deviceCommands(session),
  ...artifactsPaletteCommands(session),
  ...settingsOwnerCommands(session),
  sidebarViewCommand(deps.settings),
  ...webhookCommands(session),
  {
    id: "settings",
    label: "Settings",
    group: "General",
    keywords: ["preferences", "configuration"],
    run: () => session.showSettings("general", "palette"),
  },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    group: "General",
    hint: comboHint("global.show-shortcuts"),
    keywords: ["keybindings", "keys"],
    run: () => deps.showShortcuts(),
  },
  ];
}
