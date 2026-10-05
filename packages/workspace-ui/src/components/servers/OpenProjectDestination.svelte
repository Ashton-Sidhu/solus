<script lang="ts">
  import ContentSkeleton from "../ui/ContentSkeleton.svelte";
import Icon from "@iconify/svelte";
  import { slide } from "svelte/transition";
  import {
    LoaderCircle as LoaderIcon,
    Search as MagnifyingGlassIcon,
  } from "@lucide/svelte";
  import NewProjectNameField from "./NewProjectNameField.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { abbreviateHome } from "../../lib/paths";
  import DevicePrompt from "./DevicePrompt.svelte";
  import HostReadinessNotes from "./HostReadinessNotes.svelte";
  import type { OpenProjectStore } from "./open-project.store.svelte";

  interface Props {
    store: OpenProjectStore;
    /** Index into the store's own visible list — the parent owns ↑↓ for every step. */
    highlightedIndex: number;
    onHighlight: (index: number) => void;
    onActivate: (index: number) => void;
    /** Opens the host-scoped folder browser for the destination field. */
    onBrowse: () => void;
    inputEl?: HTMLInputElement | HTMLTextAreaElement | null;
    localIdentity?: { name: string; email: string } | null;
  }

  let {
    store,
    highlightedIndex,
    onHighlight,
    onActivate,
    onBrowse,
    inputEl = $bindable(null),
    localIdentity = null,
  }: Props = $props();

  const isClone = $derived(store.source === "clone");
  const setup = $derived(store.setup);
  const protocolWarning = $derived.by((): { message: string; blocking: boolean } | null => {
    if (!store.cloneUrl) return null;
    const host = store.hostLabel || "this machine";
    if (store.protocol === "https") {
      return store.readiness?.github?.solusToken
        ? null
        : { message: `Public repositories only, until ${host} signs in to GitHub.`, blocking: false };
    }
    if (store.sshKeyMissing) return { message: `There is no SSH key on ${host}.`, blocking: true };
    if (store.sshAccess && !store.sshAccess.ok) return { message: store.sshAccess.message, blocking: true };
    return null;
  });
  const destination = $derived(store.destinationPreview);

  async function connectGithub() {
    const boundSetup = store.setup;
    if (!boundSetup) return;
    await boundSetup.runStep("github");
    // A connection started on one host must not reload repositories for a host
    // selected while its browser flow was still open.
    if (store.setup === boundSetup) await store.loadRepos();
  }
</script>

{#if store.source === "new"}
  <div class="flex flex-col gap-3 border-t border-border px-5 pb-5 pt-4 text-workspace-chrome">
    <div class="flex min-w-0 items-end gap-3 py-1">
      <NewProjectNameField
        bind:value={store.newProjectName}
        bind:inputEl
        parent={store.newProjectParent ?? store.projectsRoot}
        platform={store.platform}
        hostLabel={store.hostLabel || "this machine"}
        disabled={store.creatingProject}
        onchangeparent={() => { store.beginBrowse(); onBrowse(); }}
        showsLabel
        class="h-9 rounded-lg bg-muted px-2.5 text-base"
      />
      {#if store.creatingProject}
        <LoaderIcon size={15} class="mb-7 shrink-0 animate-spin text-muted-foreground" aria-label="Creating" />
      {/if}
    </div>

    {#if store.createError}
      <p role="alert" class="text-pretty text-(--solus-status-error)" transition:slide={{ duration: 160 }}>
        {store.createError}
      </p>
    {/if}
  </div>
{:else if isClone}
  <div class="text-xs flex flex-col gap-4 border-t border-border px-5 pb-5 pt-[1.125rem]">
    <label class="flex flex-col gap-1.5">
      <span class="text-muted-foreground">Repository URL</span>
      <Input
        bind:ref={inputEl}
        bind:value={store.query}
        class="h-[2.125rem] rounded-lg border-0 bg-muted px-2.5 text-xs text-foreground shadow-none focus-visible:ring-0 dark:bg-muted"
        placeholder="https://github.com/org/repo.git"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        dictation={false}
        aria-label="Repository URL"
      />
    </label>

    <div class="flex flex-col gap-1.5">
      <span class="text-muted-foreground">Destination</span>
      <div class="flex items-center gap-2">
        <!-- Read-only: the host resolves the final path itself, and picking one
             here is what "Choose…" does — it clones straight into that folder. -->
        <span
          class="flex h-[2.125rem] min-w-0 flex-1 items-center truncate rounded-lg bg-muted px-2.5 font-mono 
            {destination ? 'text-foreground' : 'text-muted-foreground'}"
          title={destination ?? undefined}
        >
          {abbreviateHome(destination ?? store.projectsRoot)}
        </span>
        <Button
          variant="outline"
          class="h-[2.125rem] shrink-0 px-3 text-sm"
          onclick={() => { store.beginBrowse(); onBrowse(); }}
        >
          Choose…
        </Button>
      </div>
    </div>

    <p class="text-pretty  leading-relaxed text-muted-foreground">
      {#if destination}
        Clones onto {store.hostLabel || "this machine"} as {abbreviateHome(destination)}
      {:else}
        Paste an HTTPS or SSH clone URL — or just <span class="font-mono">owner/repo</span> for GitHub.
      {/if}
    </p>
  </div>
{:else if store.source === "github"}
  <div class="text-xs border-t border-border px-3 pb-2 pt-3">
    <label
      class="mb-1 flex h-[2.125rem] items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)] bg-transparent px-2.5 transition-[border-color] duration-100 ease-in-out focus-within:border-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)]"
    >
      <MagnifyingGlassIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
      <Input
        bind:ref={inputEl}
        bind:value={store.query}
        class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm text-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
        placeholder="Search repositories"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        dictation={false}
        role="combobox"
        aria-label="Search repositories"
        aria-expanded={store.filteredRepos.length > 0}
        aria-controls="open-project-list"
      />
      {#if store.readiness?.github?.solusLogin}
        <span class="shrink-0  text-muted-foreground">{store.readiness?.github?.solusLogin}</span>
      {/if}
    </label>

    {#if store.needsGithubOnHost}
      <div class="flex h-[16.625rem] flex-col items-center justify-center gap-1 px-8 text-center">
        <Icon icon="logos:github-icon" size={22} weight="fill" class="mb-1 text-muted-foreground" />
        <div class="text-pretty text-sm font-medium">
          {store.hostLabel || "This machine"} isn’t signed in to GitHub
        </div>
        <div class="text-pretty  leading-relaxed text-muted-foreground">
          {store.hostIsLocal
            ? "Sign in to browse and clone the repositories you can access."
            : "Each machine keeps its own credentials — nothing carries over from this one."}
        </div>
        {#if setup?.deviceCode}
          <DevicePrompt
            url={setup.deviceCode.verificationUri}
            code={setup.deviceCode.userCode}
            why="Confirm this code on GitHub, then come back."
          />
          <Button variant="ghost" size="sm" onclick={() => void setup?.cancelGithubConnect()}>
            Cancel
          </Button>
        {:else}
          <Button
            class="mt-3 px-3.5 text-sm"
            disabled={setup?.runningStep === "github"}
            onclick={() => void connectGithub()}
          >
            {setup?.runningStep === "github" ? "Waiting for GitHub…" : "Connect GitHub"}
          </Button>
        {/if}
      </div>
    {:else}
      <div
        id="open-project-list"
        role="listbox"
        aria-label="Repositories"
        class="h-[16.625rem] overflow-y-auto pt-1"
      >
        {#if store.reposLoading && store.repos.length === 0}
          <ContentSkeleton label="Loading repositories" />
        {:else if store.reposError}
          <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <div class="text-pretty  leading-relaxed text-muted-foreground">
              Couldn’t load repositories: {store.reposError}
            </div>
            <Button variant="outline" class="text-sm" onclick={() => void store.loadRepos()}>
              Try again
            </Button>
          </div>
        {:else if store.filteredRepos.length === 0}
          <div class="flex h-full flex-col items-center justify-center gap-1 text-center">
            <div class="text-sm font-medium">Nothing matches “{store.query.trim()}”</div>
            <div class="text-muted-foreground">Try a different search, or clone from a URL.</div>
          </div>
        {:else}
          <!-- One line per repo: the owner is context for the name, not a second
               row of its own, so a long list stays scannable. -->
          {#each store.filteredRepos as repo, index (repo.fullName)}
            {@const selected = index === highlightedIndex}
            <button
              type="button"
              role="option"
              aria-selected={selected}
              tabindex={-1}
              class="flex h-10 w-full items-center gap-3 rounded-lg px-2.5 text-left
                [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
                {selected ? 'bg-muted' : 'hover:bg-muted'}"
              onmousemove={() => !selected && onHighlight(index)}
              onclick={() => onActivate(index)}
            >
              <span class="min-w-0 flex-1 truncate text-sm">
                <span class="text-muted-foreground">{repo.fullName.split("/")[0]}/</span>{repo.name}
              </span>
              {#if repo.private}
                <span class="shrink-0  text-muted-foreground">Private</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<!-- How the clone signs in, in one quiet line. The URL decides it (`git@…` is
     SSH); the switch is only for the person who knows they need the other. -->
{#if store.cloneUrl}
  <p class="text-xs px-5 pb-1 text-pretty leading-relaxed text-muted-foreground" transition:slide={{ duration: 160 }}>
    {#if protocolWarning}
      <span class={protocolWarning.blocking ? "text-(--solus-status-error)" : ""}>{protocolWarning.message}</span>
    {:else if store.protocol === "ssh"}
      Uses an SSH key on {store.hostLabel || "this machine"}.
    {:else}
      Uses the GitHub sign-in on {store.hostLabel || "this machine"}.
    {/if}
    <button
      type="button"
      class="rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
      onclick={() => store.chooseProtocol(store.protocol === "ssh" ? "https" : "ssh")}
    >
      {store.protocol === "ssh" ? "Use HTTPS instead" : "Use SSH instead"}
    </button>
  </p>
{/if}

<div class="text-xs px-4 pb-1">
  <HostReadinessNotes {store} {localIdentity} />
</div>
