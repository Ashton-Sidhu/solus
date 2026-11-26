<script lang="ts">
  /**
   * Your code, step 3 of the cloud flow (docs/plans/one-page-onboarding.md
   * decision 5): GitHub on the account, the repository to clone onto the host,
   * and the account's other connections. A project is a repository: choosing
   * one adds it to the organization, and "Clone and start" clones it where the
   * agents run.
   */
  import { onMount } from "svelte";
  import Icon from "@iconify/svelte";
  import { Check as CheckIcon, LoaderCircle as SpinnerIcon, Plus as PlusIcon, Search as SearchIcon } from "@lucide/svelte";
  import { serversStore, workspaceProjectsStore } from "../../contexts";
  import { Button } from "../ui/button";
  import { hostHasManagedCompute } from "../servers/lib/managed-host";
  import { cloudOnboardingStore as cloud } from "./cloud-onboarding.store.svelte";
  import { repositoryRows } from "./lib/onboarding-repositories";
  import { repositoryPreparationTitle } from "./lib/repository-preparation";
  import { openAccountConnections } from "./onboarding.store.svelte";

  let query = $state("");
  const github = $derived(cloud.account?.github ?? null);
  const projects = $derived(workspaceProjectsStore.projectsFor(cloud.workspaceServerId));
  const rows = $derived(repositoryRows(projects, cloud.repositories ?? [], query));
  const preparation = $derived(cloud.repositoryPreparation);
  const preparationTitle = $derived.by(() => {
    if (!preparation || !cloud.chosenRepositoryKey) return null;
    const host = serversStore.hostFor(preparation.serverId);
    const isStarting = hostHasManagedCompute(host) && serversStore.readinessFor(preparation.serverId).readiness !== "ready";
    return repositoryPreparationTitle(preparation.step, cloud.chosenRepositoryKey, host?.label ?? "the host", isStarting);
  });

  onMount(() => {
    void cloud.refreshGithub().then(() => {
      if (cloud.account?.github && !cloud.repositories) void cloud.loadRepositories();
    });
    // GitHub is connected in another tab; coming back asks again.
    const onFocus = () => void cloud.refreshGithub().then(() => {
      if (cloud.account?.github && !cloud.repositories) void cloud.loadRepositories();
    });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });
</script>

<div class="flex min-h-12 items-center gap-3.5">
  <span class="flex w-5 shrink-0 justify-center text-(--solus-text-secondary)"><Icon icon="simple-icons:github" width={16} height={16} /></span>
  <span class="min-w-0 flex-1 text-[14px] leading-5 font-medium text-(--solus-text-primary)">
    GitHub{#if github?.login}<span class="font-normal text-(--solus-text-tertiary)"> · {github.login}</span>{/if}
  </span>
  <div class="flex w-30 shrink-0 items-center justify-end gap-1.25 text-[13px] font-medium">
    {#if github}
      <CheckIcon size={13} strokeWidth={2.8} class="text-(--solus-status-live)" />
      <span class="text-(--solus-status-live)">Connected</span>
    {:else}
      <Button variant="outline" size="sm" class="h-7.5 rounded-md px-3 text-[13px]" onclick={openAccountConnections}>Connect</Button>
    {/if}
  </div>
</div>

{#if github}
  <div class="flex flex-col gap-1 pl-8.5">
    <label class="flex h-8.5 items-center gap-2 rounded-md border border-border px-3 focus-within:border-ring">
      <SearchIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
      <input
        bind:value={query}
        class="min-w-0 flex-1 bg-transparent text-[13px] text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary)"
        placeholder={cloud.repositories ? `Search ${cloud.repositories.length} repositories` : "Search repositories"}
        aria-label="Search repositories"
      />
    </label>
    {#if cloud.repositoriesError}
      <div class="flex min-h-10 items-center gap-3">
        <p class="m-0 min-w-0 flex-1 text-[13px] text-(--solus-status-error)" role="alert">{cloud.repositoriesError}</p>
        <Button variant="ghost" size="sm" class="h-7.5 rounded-md px-3 text-[13px]" onclick={() => void cloud.loadRepositories()}>Try again</Button>
      </div>
    {:else if !cloud.repositories && projects.length === 0}
      {#each [0, 1, 2] as index (index)}
        <div class="flex h-9.5 items-center gap-3.5"><span class="size-4 rounded-full bg-(--wash-2)"></span><span class="h-2.5 w-40 rounded-full bg-(--wash-2)"></span></div>
      {/each}
    {:else if rows.length === 0}
      <p class="m-0 py-2 text-[13px] text-(--solus-text-tertiary)">{query ? "No repository matches." : "Your GitHub account has no repositories Solus can read."}</p>
    {:else}
      <div role="radiogroup" aria-label="Repository to clone">
        {#each rows as row (row.repositoryKey)}
          {@const isChosen = cloud.chosenRepositoryKey === row.repositoryKey}
          <button
            type="button"
            role="radio"
            aria-checked={isChosen}
            disabled={!!preparation}
            class="flex h-9.5 w-full min-w-0 items-center gap-3.5 overflow-hidden rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
            onclick={() => (cloud.chosenRepositoryKey = row.repositoryKey)}
          >
            <span class="flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px]" class:border-(--solus-text-primary)={isChosen} class:border-border={!isChosen} aria-hidden="true">
              {#if isChosen}<span class="size-2 rounded-full bg-(--solus-text-primary)"></span>{/if}
            </span>
            <span class="min-w-0 flex-1 truncate text-[14px] leading-5 text-(--solus-text-primary)" class:font-medium={isChosen}>{row.name}</span>
            <span class="shrink-0 text-[12px] leading-4 text-(--solus-text-tertiary)">{row.isProject ? "Already a project" : row.detail}</span>
          </button>
        {/each}
      </div>
    {/if}
    {#if preparationTitle}
      <p class="m-0 flex items-center gap-2 text-[13px] leading-4.5 text-(--solus-text-tertiary)" role="status">
        <SpinnerIcon size={13} class="animate-spin motion-reduce:animate-none" />{preparationTitle}
      </p>
    {:else if cloud.repositoryPreparationError}
      <p class="m-0 text-[13px] leading-4.5 text-(--solus-status-error)" role="alert">{cloud.repositoryPreparationError}</p>
    {/if}
  </div>
{/if}

<div class="flex min-h-12 items-center gap-3.5">
  <span class="flex w-5 shrink-0 justify-center text-(--solus-text-tertiary)"><PlusIcon size={14} /></span>
  <span class="min-w-0 flex-1 text-[14px] leading-5 text-(--solus-text-secondary)">Google Drive, Jira, Confluence</span>
  <div class="flex w-30 shrink-0 justify-end">
    <Button variant="ghost" size="sm" class="h-7.5 rounded-md px-2 text-[13px] font-medium" onclick={openAccountConnections}>Connect more</Button>
  </div>
</div>
