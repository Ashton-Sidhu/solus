<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { getClientShellContext } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import AppSectionState from "./AppSectionState.svelte";
  import { appTime } from "../lib/app-view";

  /** The sessions linked to the app: the ones that deployed it or linked it. A row opens the session. */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  const shell = getClientShellContext();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    untrack(() => void appsStore.sessions.load(hostId, appId));
  });
  const sessions = $derived(appsStore.sessions.get(serverId, app.id));
</script>

<AppSectionState
  count={sessions?.length}
  error={appsStore.sessions.errorFor(serverId, app.id)}
  empty="No session is linked to this app."
  onRetry={() => void appsStore.sessions.load(serverId, app.id)}
>
  <ul class="m-0 flex list-none flex-col gap-px p-0" data-testid="app-sessions">
    {#each sessions ?? [] as link (link.sessionId)}
      <li class="flex min-w-0">
        <button
          type="button"
          class="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-left text-workspace-chrome text-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:h-11"
          onclick={() => shell.openResource({ kind: "session", sessionId: link.sessionId, serverId })}
        >
          <span class="min-w-0 flex-1 truncate">{link.title?.trim() || "Untitled session"}</span>
          <span class="shrink-0 text-xs tabular-nums text-muted-foreground">Linked {appTime(link.linkedAt)}</span>
        </button>
      </li>
    {/each}
  </ul>
</AppSectionState>
