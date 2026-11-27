<script lang="ts">
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../../ui/button";
  import { hostFoldersText } from "../lib/overview";
  import StateIcon from "../StateIcon.svelte";

  /**
   * What the active version may use, plain on the page: the network hosts, the
   * integrations with whether the reader has each one connected, and the host
   * folders it reads and writes.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    state: AppState | undefined;
  }
  let { serverId, app, state: appState }: Props = $props();

  const stateError = $derived(appState ? null : appsStore.stateErrorFor(serverId, app.id));
</script>

<section class="flex min-w-0 flex-col gap-2.5" aria-label="May use" data-testid="app-overview-access">
  <h3 class="m-0 text-[15px] font-semibold text-foreground">May use</h3>
  {#if appState}
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="text-xs text-(--solus-text-tertiary)">Network</span>
      {#if appState.network.length > 0}
        <span class="min-w-0 font-mono text-xs break-words text-foreground">{appState.network.join(", ")}</span>
      {:else}
        <span class="text-[13px] text-(--solus-text-tertiary)">None</span>
      {/if}
    </div>
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="text-xs text-(--solus-text-tertiary)">Integrations</span>
      {#each appState.roles as role (role.slug)}
        <span class="min-w-0 truncate text-[13px] text-foreground" title={role.name === null ? "You have no integration with this name." : undefined}>
          {role.name ?? role.slug}
          <span class="text-(--solus-text-tertiary)">· {role.name === null ? "Not set up" : role.connected ? "Connected" : "Not connected"}</span>
          {#if !role.connected}<StateIcon state="warning" size={12} class="inline align-[-1px]" />{/if}
        </span>
      {:else}
        <span class="text-[13px] text-(--solus-text-tertiary)">None</span>
      {/each}
    </div>
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="text-xs text-(--solus-text-tertiary)">Host folders</span>
      {#if appState.descriptor}
        {@const folders = hostFoldersText(appState.descriptor.permissions.files)}
        <span class="min-w-0 text-[13px] break-words {folders === 'None' ? 'text-(--solus-text-tertiary)' : 'text-foreground'}">{folders}</span>
      {:else}
        <span class="text-[13px] text-(--solus-text-tertiary)">None</span>
      {/if}
    </div>
    {#if appState.permissionsNotice}
      <p class="m-0 text-xs text-pretty text-(--solus-text-tertiary)">{appState.permissionsNotice}</p>
    {/if}
  {:else if stateError}
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[13px] text-(--solus-text-tertiary)">{stateError}</span>
      <Button size="xs" variant="outline" onclick={() => void appsStore.loadState(serverId, app.id)}>Try again</Button>
    </div>
  {:else}
    <span class="text-[13px] text-(--solus-text-tertiary)">Reading…</span>
  {/if}
</section>
