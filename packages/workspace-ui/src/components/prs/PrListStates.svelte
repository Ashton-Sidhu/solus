<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    CircleAlert as WarningCircleIcon,
    GitPullRequest as GitPullRequestIcon,
    RefreshCw as ArrowsClockwiseIcon,
  } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import PageEmpty from "../ui/PageEmpty.svelte";
  import GithubConnectionRequired from "./GithubConnectionRequired.svelte";
  import type { PrInboxFailure } from "./lib/pr-inbox-failure";
  import { prUnavailableTitle, type PrSurfaceError } from "./lib/pr-surface-error";

  /** Empty and failed states for the list. Partial failures keep their rows
   *  visible and notify through a toast from the page. */
  interface Props {
    /** Every project is in view, rather than one. */
    allProjects: boolean;
    /** A project is scoped (always true across every project). */
    hasScope: boolean;
    /** The one project's read failure. */
    scopeError: PrSurfaceError | null;
    /** The one project's name, so a state says which project it is about. */
    scopeLabel: string | null;
    /** The host the one project reads through. */
    serverId: string | null;
    /** Every project's read failures, folded into one statement. */
    projectsFailure: PrInboxFailure;
    /** Any row loaded at all — before the page's own filters. */
    hasItems: boolean;
    onRetry: () => void;
    onShowAll: () => void;
    children: Snippet;
  }
  let {
    allProjects,
    hasScope,
    scopeError,
    scopeLabel,
    serverId,
    projectsFailure,
    hasItems,
    onRetry,
    onShowAll,
    children,
  }: Props = $props();
</script>

{#snippet showAll()}
  <Button type="button" variant="outline" onclick={onShowAll}>Show all projects</Button>
{/snippet}

{#snippet retry()}
  <Button type="button" variant="outline" onclick={onRetry}>
    <ArrowsClockwiseIcon size={14} />
    Retry
  </Button>
{/snippet}

{#if !allProjects && !hasScope}
  <PageEmpty icon={GitPullRequestIcon} title="Open a project to see its pull requests.">
    The project in the input bar sets this list.
  </PageEmpty>
{:else if !allProjects && scopeError?.kind === "github-auth"}
  <PageEmpty icon={GitPullRequestIcon} tone="muted" title="Connect GitHub to load pull requests.">
    {#if serverId}
      <GithubConnectionRequired {serverId} layout="stacked" />
    {/if}
  </PageEmpty>
{:else if projectsFailure.kind === "github-auth" && projectsFailure.placement === "page"}
  <PageEmpty icon={GitPullRequestIcon} tone="muted" title="Connect GitHub to load pull requests.">
    <GithubConnectionRequired serverId={projectsFailure.serverId} layout="stacked" />
  </PageEmpty>
{:else if !allProjects && scopeError?.kind === "unavailable"}
  <!-- A project with no pull requests — Scratchpad, a plain directory, a
       repository never pushed. A state to state, not a failure. The page
       scope is shared with the other project pages, so it may have been
       picked elsewhere: name the project and offer the way back out. -->
  <PageEmpty
    icon={GitPullRequestIcon}
    tone="muted"
    title={prUnavailableTitle(scopeError.reason, scopeLabel)}
    actions={showAll}
  >
    {#if scopeError.reason === "unsupported-host"}
      Pull requests show up for repositories on GitHub.
    {:else}
      Pull requests show up once this folder points at a repository on GitHub.
    {/if}
  </PageEmpty>
{:else if !allProjects && scopeError}
  <PageEmpty icon={WarningCircleIcon} tone="muted" title="Couldn’t load pull requests." actions={retry}>
    {scopeError.message}
  </PageEmpty>
{:else if projectsFailure.kind === "generic" && projectsFailure.placement === "page"}
  <PageEmpty icon={WarningCircleIcon} tone="muted" title="Couldn’t load pull requests." actions={retry}>
    {projectsFailure.detail}
  </PageEmpty>
{:else if !hasItems}
  <PageEmpty icon={GitPullRequestIcon} title="No pull requests yet.">
    {allProjects
      ? "Open pull requests from any of your projects' remotes will show up here."
      : "Open pull requests from this project's remote will show up here."}
    {#snippet actions()}
      <Button
        type="button"
        class="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-muted px-3 text-workspace-chrome font-medium text-muted-foreground transition-colors hover:text-foreground"
        onclick={onRetry}
      >
        <ArrowsClockwiseIcon size={13} class="shrink-0" />
        Refresh
      </Button>
    {/snippet}
  </PageEmpty>
{:else}
  {@render children()}
{/if}
