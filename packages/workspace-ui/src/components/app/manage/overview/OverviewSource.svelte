<script lang="ts">
  import type { AppState, AppSummary } from "@solus/contracts/apps";
  import { shortCommit } from "@solus/client-core/app-versions";
  import { appsStore } from "../../../../contexts/apps/apps.store.svelte";
  import type { AppManageSection } from "../../../../contexts/workspace/routing/route-registry";
  import { Button } from "../../../ui/button";
  import CopyButton from "../../../ui/CopyButton.svelte";
  import { APP_SOURCE_TEXT } from "../../lib/app-view";
  import { madeText } from "../lib/overview";

  /**
   * Where the app came from and where its source is (docs/plans/apps.md §4.2):
   * the project folder of its first save, its slug, who made it and in how
   * many sessions, its git repository on the host, and its newest revision.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state; the repository path is in it. */
    state: AppState | undefined;
    onSelectSection: (section: AppManageSection) => void;
  }
  let { serverId, app, state: appState, onSelectSection }: Props = $props();

  const sessions = $derived(appsStore.sessions.get(serverId, app.id));
  const stateError = $derived(appState ? null : appsStore.stateErrorFor(serverId, app.id));
</script>

<!-- One fact: a small label over its value. A path, an id, and a commit are monospace, with a copy button. -->
{#snippet fact(label: string, value: string, copyTitle?: string, copyText?: string)}
  <div class="flex min-w-0 flex-col gap-0.5">
    <span class="text-xs text-(--solus-text-tertiary)">{label}</span>
    <div class="flex min-w-0 items-center gap-1">
      <span class="min-w-0 truncate {copyTitle ? 'font-mono text-xs' : 'text-[13px]'} text-foreground" title={copyText ?? value}>{value}</span>
      {#if copyTitle}
        <CopyButton text={copyText ?? value} title={copyTitle} iconOnly refocusInput={false} />
      {/if}
    </div>
  </div>
{/snippet}

<section class="flex min-w-0 flex-col gap-2.5" aria-label="Source" data-testid="app-source">
  <h3 class="m-0 text-[15px] font-semibold text-foreground">Source</h3>
  {#if app.project}
    {@render fact("Project folder", app.project, "Copy the folder")}
  {/if}
  {@render fact("Slug", app.slug)}
  <div class="flex min-w-0 flex-col gap-0.5">
    <span class="text-xs text-(--solus-text-tertiary)">Made</span>
    {#if sessions && sessions.length > 0}
      <button
        type="button"
        class="cursor-pointer self-start rounded border-0 bg-transparent p-0 text-left text-[13px] text-foreground underline-offset-3 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
        title="Open Sessions"
        onclick={() => onSelectSection("sessions")}>{madeText(app.createdAt, app.createdBy, sessions.length)}</button
      >
    {:else}
      <span class="text-[13px] text-foreground">{madeText(app.createdAt, app.createdBy, undefined)}</span>
    {/if}
  </div>
  <div data-testid="app-overview-repository">
    {#if appState}
      {@render fact("Repository on the host", appState.repositoryPath, "Copy the repository path")}
    {:else}
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-xs text-(--solus-text-tertiary)">Repository on the host</span>
        <div class="flex items-center gap-2">
          <span class="text-[13px] text-(--solus-text-tertiary)">{stateError ?? "Reading…"}</span>
          {#if stateError}
            <Button size="xs" variant="outline" onclick={() => void appsStore.loadState(serverId, app.id)}>Try again</Button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
  <div data-testid="app-overview-revision">
    {#if app.latestRevision}
      {@render fact(app.hasUndeployedRevision ? "Newest revision · waits for a deploy" : "Newest revision", shortCommit(app.latestRevision), "Copy the revision", app.latestRevision)}
    {:else}
      {@render fact("Newest revision", "Nothing was saved yet.")}
    {/if}
  </div>
  <p class="m-0 text-xs text-pretty text-(--solus-text-tertiary)">{APP_SOURCE_TEXT}</p>
</section>
