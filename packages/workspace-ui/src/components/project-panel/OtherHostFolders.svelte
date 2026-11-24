<script lang="ts">
  import { Folder as FolderIcon, FolderGit2 as RepositoryIcon, Server as HostIcon } from "@lucide/svelte";
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import AgentAvatar from "../conversation/AgentAvatar.svelte";
  import { openAgentSession } from "../conversation/agent-conversation/lib/agent-conversation";
  import { memberStateLabel } from "../codebases/lib/codebase-view";
  import { PANEL_ROW_ICON_SIZE } from "./MenuRow.svelte";
  import { childRepositoryNote, type OtherHostFolders } from "./lib/environment-folders";

  /** The folders of the session's codebase on the hosts it does not run on,
   *  and the child sessions that work there. A session changes only the
   *  folders on its own host, so these rows show and open; they do not edit. */
  interface Props {
    tabId: string;
    hosts: OtherHostFolders[];
  }
  let { tabId, hosts }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  async function openChild(host: OtherHostFolders, child: OtherHostFolders["sessions"][number]) {
    if (!host.serverId) return;
    try {
      await openAgentSession(
        { sessionId: child.id, cwd: child.cwd },
        child.provider,
        host.serverId,
        {
          resume: (resumed, opts) => session.opening.resumeSession(resumed, opts),
          openInSplit: (openedTabId) => session.openTabAsSurface(openedTabId),
        },
      );
    } catch (error) {
      toasts.error("Could not open the session", { description: String(error) });
      requestInputFocus({ tabId });
    }
  }
</script>

{#each hosts as host (host.installationId)}
  <div class="flex flex-col gap-px" role="group" aria-label="Folders on {host.label}">
    <div class="flex min-h-6 min-w-0 items-center gap-1.5 px-2 text-chrome-dense text-(--solus-text-tertiary)">
      <HostIcon size={12} class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{host.label}</span>
      {#if host.presenceNote}
        <span class="shrink-0">{host.presenceNote}</span>
      {/if}
    </div>
    {#each host.roots as root (root.path)}
      {@const RootIcon = root.state === "git" ? RepositoryIcon : FolderIcon}
      <div class="flex min-h-8 min-w-0 items-center gap-2 px-2 text-(--solus-text-secondary)" title={root.path}>
        <RootIcon size={PANEL_ROW_ICON_SIZE} class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{root.name}</span>
        {#if root.state && root.state !== "git"}
          <span class="shrink-0 text-chrome-dense text-(--solus-text-tertiary)">{memberStateLabel(root.state)}</span>
        {/if}
      </div>
    {/each}
    {#each host.sessions as child (child.key)}
      {@const note = host.serverId ? childRepositoryNote(environmentStore.statusFor(host.serverId, child.cwd)) : null}
      <button
        type="button"
        class="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg pl-5 pr-2 text-left text-(--solus-text-secondary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
        aria-label="Open {child.title}, {child.status}"
        onclick={() => void openChild(host, child)}
      >
        <AgentAvatar provider={child.provider} variant="row" />
        <span class="min-w-0 flex-1 truncate">{child.title}</span>
        <span class="max-w-1/2 shrink-0 truncate text-chrome-dense text-(--solus-text-tertiary)">{note ?? child.status}</span>
      </button>
    {/each}
  </div>
{/each}
