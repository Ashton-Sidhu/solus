<script lang="ts">
  /**
   * "Open existing code", asked as one more stage in the same way as naming a
   * new project: the flow keeps its own shape until a folder is chosen, and
   * ends in a draft in it with the composer focused.
   *
   * A recent project on the host opens at once. Any other folder is chosen in
   * the host's folder browser, which is drawn over this stage.
   */
  import { onMount } from "svelte";
  import {
    FolderGit2 as RepositoryIcon,
    FolderOpen as FolderOpenIcon,
  } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { projectsStore, runtime, serversStore } from "../../contexts";
  import { abbreviateHome } from "../../lib/paths";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  interface Props {
    /** The host the folder is on. */
    serverId: string;
    onopened: (project: { serverId: string; path: string }) => void;
    onskip: () => void;
  }

  let { serverId, onopened, onskip }: Props = $props();

  let pickerOpen = $state(false);
  let choicesEl = $state<HTMLDivElement | null>(null);

  const hostLabel = $derived(
    serversStore.hostFor(serverId)?.label ?? "this machine",
  );
  const recents = $derived(projectsStore.recentProjectsFor(serverId).slice(0, 4));
  const recentsLoading = $derived(
    projectsStore.recentProjectsLoadingFor(serverId) && recents.length === 0,
  );

  onMount(() => {
    if (serverId) void projectsStore.loadRecentProjects(serverId);
    // Enter then opens the first choice: the newest recent, else the folder browser.
    if (!runtime.shouldSuppressFocus)
      requestAnimationFrame(() => choicesEl?.querySelector("button")?.focus());
  });

  function open(path: string) {
    pickerOpen = false;
    onopened({ serverId, path });
  }
</script>

<div
  class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12"
>
  <h1
    class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12]"
  >
    Open your code
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[40ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    Choose a folder on {hostLabel}. Then tell an agent what to do!
  </p>

  <div
    bind:this={choicesEl}
    class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10"
  >
    {#if recentsLoading}
      <div
        class="flex flex-col overflow-hidden rounded-2xl bg-[var(--solus-tx-card-bg)] shadow-[shadow:var(--solus-tx-card-shadow)]"
        aria-label="Loading recent projects"
      >
        {#each [0, 1] as index (index)}
          <div
            class="flex min-h-14 items-center gap-3 px-4 not-last:shadow-[inset_0_-1px_0_var(--hairline)]"
          >
            <span class="size-4 shrink-0 rounded bg-[var(--wash-2)]"></span>
            <span class="flex flex-col gap-2">
              <span class="h-2.5 w-[9rem] rounded-full bg-[var(--wash-2)]"></span>
              <span class="h-2 w-[6rem] rounded-full bg-[var(--wash-2)] opacity-60"></span>
            </span>
          </div>
        {/each}
      </div>
    {:else if recents.length > 0}
      <!-- One list, not a stack of cards: a recent project is picked, not set
           up, so the whole row is the control. -->
      <div
        class="onboarding-enter flex flex-col overflow-hidden rounded-2xl bg-[var(--solus-tx-card-bg)] shadow-[shadow:var(--solus-tx-card-shadow)]"
        style="animation-delay: 0.14s"
      >
        {#each recents as project (project.path)}
          <button
            type="button"
            class="flex min-h-14 w-full items-center gap-3 overflow-hidden px-4 py-2.5 text-left transition-colors duration-150 not-last:shadow-[inset_0_-1px_0_var(--hairline)] hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-1)] focus-visible:outline-none"
            onclick={() => open(project.path)}
          >
            <RepositoryIcon size={16} class="shrink-0 text-muted-foreground" />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="truncate text-sm font-medium">{project.folderName}</span>
              <span class="truncate text-xs text-muted-foreground">{abbreviateHome(project.path)}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}

    <OnboardingRow
      name="Choose a folder…"
      detail="Browse {hostLabel} for a codebase"
      delay={0.22}
      tint="var(--chart-1)"
      state="available"
      onpick={() => (pickerOpen = true)}
    >
      {#snippet mark()}
        <FolderOpenIcon size={18} />
      {/snippet}
    </OnboardingRow>
  </div>

  <OnboardingStageActions
    continueLabel="Choose a folder…"
    continueEnabled={!!serverId}
    oncontinue={() => (pickerOpen = true)}
    onback={() => store.back()}
    {onskip}
    skipLabel="Just chat"
  />
</div>

{#if serverId}
  <DirectoryPicker
    bind:open={pickerOpen}
    onClose={() => (pickerOpen = false)}
    onSelect={open}
    title="Open a folder"
    actionLabel="Open"
    api={serverConnections.apiFor(serverId)}
    {serverId}
  />
{/if}
