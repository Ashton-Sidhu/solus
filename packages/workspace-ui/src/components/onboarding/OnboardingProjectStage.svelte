<script lang="ts">
  /**
   * The repository choice under "Open existing code" in cloud onboarding.
   * A project is a repository: choosing one adds it to Solus Cloud, where every
   * member of the organization sees its tasks and pull requests. Start makes it
   * a project on the machine it runs on — cloning it there when no online
   * machine holds it — and the flow ends in a draft in that checkout. The
   * chosen row reports the clone while it runs, and why it failed.
   */
  import {
    Check as CheckIcon,
    CircleAlert as CircleAlertIcon,
    FolderGit2 as RepositoryIcon,
    LoaderCircle as LoaderIcon,
  } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { serversStore, workspaceProjectsStore } from "../../contexts";
  import { hostIsManaged } from "../servers/lib/managed-host";
  import { repositoryPreparationTitle } from "./lib/repository-preparation";
  import { Input } from "../ui/input";
  import { cn } from "../../lib/utils";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { repositoryRows } from "./lib/onboarding-repositories";
  import { onboardingStore as store } from "./onboarding.store.svelte";
  import OnboardingRow from "./OnboardingRow.svelte";
  import OnboardingStageActions from "./OnboardingStageActions.svelte";

  interface Props {
    onstart: () => void;
    onskip: () => void;
  }

  let { onstart, onskip }: Props = $props();

  let query = $state("");
  const projects = $derived(workspaceProjectsStore.projectsFor(cloud.workspaceServerId));
  const rows = $derived(repositoryRows(projects, cloud.repositories ?? [], query));
  const organizationName = $derived(cloud.organization?.name ?? "your organization");
  const preparation = $derived(cloud.repositoryPreparation);
  const preparationError = $derived(cloud.repositoryPreparationError);
  const preparationTitle = $derived.by(() => {
    if (!preparation || !cloud.chosenRepositoryKey) return null;
    const host = serversStore.hostFor(preparation.serverId);
    const hostIsStarting =
      hostIsManaged(host) && serversStore.statusFor(preparation.serverId) !== "online";
    return repositoryPreparationTitle(
      preparation.step,
      cloud.chosenRepositoryKey,
      host?.label ?? preparation.serverId,
      hostIsStarting,
    );
  });

  onMount(() => {
    if (!cloud.repositories) void cloud.loadRepositories();
  });
</script>

<div class="flex min-h-full flex-col items-center justify-center px-6 py-10 sm:px-10 sm:py-12">
  <h1 class="onboarding-title m-0 shrink-0 text-center text-2xl font-medium leading-[1.12]">
    Choose a repository
  </h1>
  <p
    class="onboarding-title mt-3 max-w-[40ch] shrink-0 text-center text-sm leading-[1.6] text-muted-foreground"
    style="animation-delay: 0.06s"
  >
    A project is a repository. Everyone in {organizationName} sees its tasks and pull requests.
  </p>

  <div class="mt-8 flex w-full max-w-[28.25rem] shrink-0 flex-col gap-2.5 sm:mt-10">
    <Input placeholder="Search repositories" aria-label="Search repositories" bind:value={query} />

    {#if cloud.repositoriesError}
      <OnboardingRow
        name="Could not list your repositories"
        detail={cloud.repositoriesError}
        tint="var(--solus-status-error)"
        state="available"
        actionLabel="Retry"
        onaction={() => void cloud.loadRepositories()}
      />
    {:else if !cloud.repositories && projects.length === 0}
      <div
        class="flex flex-col overflow-hidden rounded-2xl bg-[var(--solus-tx-card-bg)] shadow-[shadow:var(--solus-tx-card-shadow)]"
      >
        {#each [0, 1, 2] as index (index)}
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
    {:else if rows.length === 0}
      <p class="px-1 text-sm text-muted-foreground">
        {query ? "No repository matches." : "Your GitHub account has no repositories Solus can read."}
      </p>
    {:else}
      <!-- One list, not a stack of cards: a repository is picked, not set up,
           so the whole row is the control and the trailing slot only reports. -->
      <div
        class="onboarding-enter flex flex-col overflow-hidden rounded-2xl bg-[var(--solus-tx-card-bg)] shadow-[shadow:var(--solus-tx-card-shadow)]"
      >
        {#each rows as row (row.repositoryKey)}
          {@const isAdding = cloud.addingRepositoryKey === row.repositoryKey}
          {@const isChosen = cloud.chosenRepositoryKey === row.repositoryKey}
          <button
            type="button"
            class={cn(
              "flex min-h-14 w-full items-center gap-3 overflow-hidden px-4 py-2.5 text-left transition-colors duration-150 not-last:shadow-[inset_0_-1px_0_var(--hairline)] hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-1)] focus-visible:outline-none disabled:cursor-default",
              isChosen && "bg-[var(--wash-1)]",
            )}
            aria-pressed={isChosen}
            disabled={!!cloud.addingRepositoryKey || !!preparation}
            onclick={() => void cloud.chooseRepository(row.repositoryKey)}
          >
            <RepositoryIcon size={16} class="shrink-0 text-muted-foreground" />
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="truncate text-sm font-medium">{row.name}</span>
              {#if isChosen && preparationTitle}
                <span class="truncate text-xs text-muted-foreground" role="status">{preparationTitle}</span>
              {:else if isChosen && preparationError}
                <span class="text-xs text-pretty text-(--solus-status-error)" role="alert">{preparationError}</span>
              {:else}
                <span class="truncate text-xs text-muted-foreground" title={row.detail}>{row.detail}</span>
              {/if}
            </span>
            {#if isAdding || (isChosen && preparation)}
              <LoaderIcon
                size={14}
                class="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-label={isAdding ? "Adding" : "Preparing"}
              />
            {:else if isChosen && preparationError}
              <CircleAlertIcon size={15} class="shrink-0 text-(--solus-status-error)" aria-hidden="true" />
            {:else if isChosen}
              <CheckIcon size={15} class="shrink-0 text-primary" aria-label="Chosen" />
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <OnboardingStageActions
    continueLabel={preparationError ? "Try again" : "Start"}
    continueEnabled={!!cloud.chosenRepositoryKey && !cloud.addingRepositoryKey && !preparation}
    oncontinue={onstart}
    onback={preparation ? undefined : () => store.back()}
    {onskip}
    skipLabel="Just chat"
  />
</div>
