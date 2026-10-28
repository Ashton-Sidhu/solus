<script lang="ts">
  import { CHATS_GROUP_KEY, getSessionSidebarStore, getWorkspaceContext, hosts } from "../../contexts";
  import { openChatDraft } from "../../contexts/workspace/new-chat";
  import { requestInputFocus } from "../../lib/inputFocus";
  import ProjectFolderContextMenu from "./ProjectFolderContextMenu.svelte";
  import SidebarFolderHeader from "./SidebarFolderHeader.svelte";
  import SidebarList, { type SidebarListShared } from "./SidebarList.svelte";
  import { SidebarFolderState } from "./lib/sidebar-folder-state.svelte";
  import type { SidebarListInput } from "./lib/sidebar-list-items";
  import { buildProjectListItems, type SidebarFolder } from "./lib/sidebar-project-folders";

  /** The sidebar's project view: the person's open sessions in one folder per
   *  project, working or not, with the shelves below
   *  (docs/plans/sidebar-project-view.md). */
  interface Props {
    input: SidebarListInput;
    list: SidebarListShared;
    /** A search opens every folder, so each hit has a row to land on. */
    isSearching: boolean;
    onSessionSelect?: () => void;
  }
  let { input, list, isSearching, onSessionSelect }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();
  const folders = new SidebarFolderState(globalThis.localStorage ?? null);

  const items = $derived(
    buildProjectListItems({
      drafts: input.drafts,
      sessions: [...input.sessions, ...input.working],
      shared: input.shared,
      snoozed: input.snoozed,
      completed: input.completed,
      isSharedOpen: input.isSharedOpen,
      isSnoozedOpen: input.isSnoozedOpen,
      isCompletedOpen: input.isCompletedOpen,
      shelfRevealTaskId: input.shelfRevealTaskId,
      projects: sidebarStore.projectFilterChoices,
      isFolderOpen: (folderKey) => isSearching || folders.isOpen(folderKey),
      sentAt: (row) => sidebarStore.sentAtFor(row),
    }),
  );

  let folderMenu = $state<{ folder: SidebarFolder; x: number; y: number } | null>(null);

  /** A session in the folder's project, on the host of the checkout the
   *  folder names. Absent where no session can start: a project no
   *  connected host holds, or a host that does not let this person start one. */
  function newSessionIn(folder: SidebarFolder): (() => void) | undefined {
    if (folder.key === CHATS_GROUP_KEY) {
      return () => {
        openChatDraft(session, "click");
        onSessionSelect?.();
      };
    }
    const project = folder.project;
    if (!project || folder.key === "~" || !project.available) return undefined;
    if (!hosts.get(project.serverId).me.may("host.sessions.start")) return undefined;
    return () => {
      session.drafts.openSessionDraft({ freshTask: true, serverId: project.serverId, via: "click" }, project.projectKey);
      requestInputFocus();
      onSessionSelect?.();
    };
  }

  /** The path a folder names on its host. A chat or `~` has none worth copying. */
  function pathOf(folder: SidebarFolder): string | undefined {
    return folder.key === CHATS_GROUP_KEY || folder.key === "~" ? undefined : folder.project?.projectKey;
  }

  function openFolderMenu(event: MouseEvent, folder: SidebarFolder) {
    event.preventDefault();
    event.stopPropagation();
    if (!newSessionIn(folder) && !pathOf(folder)) return;
    folderMenu = { folder, x: event.clientX, y: event.clientY };
  }
</script>

{#snippet folderHeader(folder: SidebarFolder)}
  <SidebarFolderHeader
    {folder}
    onToggle={() => folders.toggle(folder.key)}
    onNewSession={newSessionIn(folder)}
    onContextMenu={(event) => openFolderMenu(event, folder)}
  />
{/snippet}

<SidebarList
  {...list}
  {items}
  {folderHeader}
  onFolderOpenChange={(folderKey, isOpen) => folders.setOpen(folderKey, isOpen)}
/>

{#if folderMenu}
  {@const menuFolder = folderMenu.folder}
  <ProjectFolderContextMenu
    x={folderMenu.x}
    y={folderMenu.y}
    onNewSession={newSessionIn(menuFolder)}
    path={pathOf(menuFolder)}
    onClose={() => (folderMenu = null)}
  />
{/if}
