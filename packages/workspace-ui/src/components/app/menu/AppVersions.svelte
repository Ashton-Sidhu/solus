<script lang="ts">
  import { untrack } from "svelte";
  import type { AppSummary } from "@solus/contracts/apps";
  import { attributionLabel } from "@solus/contracts/user";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import AppSectionState from "./AppSectionState.svelte";
  import AppVersionChanges from "./AppVersionChanges.svelte";
  import { APP_ROLLBACK_NOTE, appTime, versionStateLabel } from "../lib/app-view";

  /** The versions of one app, newest first: what each one is, its source change, and Make active. */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    untrack(() => void appsStore.versions.load(hostId, appId));
  });
  const versions = $derived(appsStore.versions.get(serverId, app.id));

  /** The version whose source change shows. */
  let changesOf = $state<number | null>(null);
  let isBusy = $state(false);

  async function makeActive(version: number) {
    if (isBusy) return;
    isBusy = true;
    try {
      await appsStore.activate(serverId, app.id, version);
    } catch (error) {
      toasts.error("The version did not become active", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      isBusy = false;
    }
  }
</script>

<AppSectionState
  count={versions?.length}
  error={appsStore.versions.errorFor(serverId, app.id)}
  empty="This app has no version yet."
  onRetry={() => void appsStore.versions.load(serverId, app.id)}
>
  <p class="m-0 pb-2 text-xs text-muted-foreground">Make active: {APP_ROLLBACK_NOTE}</p>
  <ul class="m-0 flex list-none flex-col gap-2 p-0" data-testid="app-versions">
    {#each versions ?? [] as version (version.number)}
      <li class="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 px-3 py-2">
        <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="shrink-0 font-medium tabular-nums">v{version.number}</span>
          <span class="shrink-0 text-xs {version.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{versionStateLabel(version.state)}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={version.message}>{version.message}</span>
          <span class="shrink-0 text-xs text-muted-foreground">{attributionLabel(version.createdBy)} · {appTime(version.createdAt)}</span>
        </div>
        {#if version.error}
          <p class="m-0 text-xs text-destructive text-pretty">{version.error}</p>
        {/if}
        {#if version.permissionsNotice}
          <p class="m-0 text-xs text-muted-foreground text-pretty">{version.permissionsNotice}</p>
        {/if}
        <div class="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            aria-expanded={changesOf === version.number}
            onclick={() => (changesOf = changesOf === version.number ? null : version.number)}
          >
            {changesOf === version.number ? "Hide changes" : "View changes"}
          </Button>
          {#if version.state === "superseded"}
            <Button size="xs" variant="outline" disabled={isBusy} onclick={() => void makeActive(version.number)}>Make active</Button>
          {/if}
        </div>
        {#if changesOf === version.number}
          <AppVersionChanges {serverId} appId={app.id} version={version.number} />
        {/if}
      </li>
    {/each}
  </ul>
</AppSectionState>
