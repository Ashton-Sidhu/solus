<script lang="ts">
  import { Trash2 as DeleteIcon } from "@lucide/svelte";
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../contexts/workspace/routing/route-registry";
  import { Button } from "../../ui/button";
  import CopyButton from "../../ui/CopyButton.svelte";
  import ManageHeading from "./ManageHeading.svelte";
  import { APP_SOURCE_TEXT } from "../lib/app-view";
  import { shortCommit } from "./lib/timeline";

  /**
   * Where the app's source is (docs/plans/apps.md §4.2, §9.2): its slug, its
   * git repository on the host, and its newest revision. The owner deletes the app here.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state; the repository path is in it. */
    state: AppState | undefined;
    busy: boolean;
    onSelectSection: (section: AppManageSection) => void;
    onDelete: () => void;
  }
  let { serverId, app, state: appState, busy, onSelectSection, onDelete }: Props = $props();

  const stateError = $derived(appsStore.stateErrorFor(serverId, app.id));
</script>

<ManageHeading title="Source" description={APP_SOURCE_TEXT} />

<div class="flex flex-col gap-6">
  <dl class="m-0 flex flex-col gap-px overflow-hidden rounded-xl border border-border/50 bg-border/50" data-testid="app-source">
    <div class="flex min-w-0 items-center gap-2 bg-background px-3 py-2">
      <dt class="w-24 shrink-0 text-xs text-muted-foreground">Slug</dt>
      <dd class="m-0 flex min-w-0 flex-1 items-center gap-1.5">
        <code class="min-w-0 truncate font-mono text-xs">{app.slug}</code>
        <CopyButton text={app.slug} title="Copy the slug" iconOnly />
      </dd>
    </div>
    <div class="flex min-w-0 items-center gap-2 bg-background px-3 py-2">
      <dt class="w-24 shrink-0 text-xs text-muted-foreground">Repository</dt>
      <dd class="m-0 flex min-w-0 flex-1 items-center gap-1.5">
        {#if appState}
          <code class="min-w-0 truncate font-mono text-xs" title={appState.repositoryPath}>{appState.repositoryPath}</code>
          <CopyButton text={appState.repositoryPath} title="Copy the repository path" iconOnly />
        {:else if stateError}
          <span class="min-w-0 truncate text-xs text-destructive" role="alert" title={stateError}>{stateError}</span>
          <Button size="xs" variant="outline" onclick={() => void appsStore.loadState(serverId, app.id)}>Try again</Button>
        {:else}
          <span class="text-xs text-muted-foreground" role="status" aria-busy="true">Loading…</span>
        {/if}
      </dd>
    </div>
    <div class="flex min-w-0 items-center gap-2 bg-background px-3 py-2">
      <dt class="w-24 shrink-0 text-xs text-muted-foreground">Newest revision</dt>
      <dd class="m-0 flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1">
        {#if app.latestRevision}
          <code class="shrink-0 font-mono text-xs" title={app.latestRevision}>{shortCommit(app.latestRevision)}</code>
          <CopyButton text={app.latestRevision} title="Copy the revision" iconOnly />
          {#if app.hasUndeployedRevision}
            <span class="text-xs text-muted-foreground">It waits for a deploy.</span>
          {/if}
          <Button size="xs" variant="link" class="h-auto px-0" onclick={() => onSelectSection("versions")}>Open Versions</Button>
        {:else}
          <span class="text-xs text-muted-foreground">None</span>
        {/if}
      </dd>
    </div>
  </dl>
  <p class="m-0 text-xs text-muted-foreground text-pretty">
    The repository is a git repository on the host of the app. The branch <code class="font-mono">main</code> holds one commit for each save. Only the host writes to it.
  </p>

  <section class="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 rounded-xl border border-destructive/30 px-3 py-3" aria-label="Delete the app">
    <div class="flex min-w-40 flex-1 flex-col gap-0.5">
      <span class="text-sm font-medium">Delete this app</span>
      <span class="text-xs text-muted-foreground text-pretty">Its data, its repository, its schedules, its secrets, and its webhooks are deleted. You cannot get them back.</span>
    </div>
    <Button size="xs" variant="destructive" disabled={busy} onclick={onDelete} data-testid="app-source-delete">
      <DeleteIcon size={12} /> Delete…
    </Button>
  </section>
</div>
