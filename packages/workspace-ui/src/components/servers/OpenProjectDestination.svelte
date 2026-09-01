<script lang="ts">
import Icon from "@iconify/svelte";
  import { slide } from "svelte/transition";
  import { LoaderCircle as CircleNotchIcon, Search as MagnifyingGlassIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import type { CloneProtocol } from "@solus/contracts/types";
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

  const PROTOCOLS: CloneProtocol[] = ["https", "ssh"];
  const isClone = $derived(store.source === "clone");
  const setup = $derived(store.setup);
  const showProtocol = $derived(!!store.cloneUrl);
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

{#if isClone}
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
    <label class="mb-1 flex h-[2.125rem] items-center gap-2 rounded-lg bg-muted px-2.5">
      <MagnifyingGlassIcon size={13} class="shrink-0 text-muted-foreground" />
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
          <div class="flex h-full items-center justify-center gap-2  text-muted-foreground">
            <CircleNotchIcon size={14} class="animate-spin" />
            Loading repositories…
          </div>
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

{#if showProtocol}
  <div class="text-xs flex items-center gap-2 px-5 pb-1" transition:slide={{ duration: 160 }}>
    <div class="inline-flex h-7 shrink-0 items-center rounded-lg bg-muted p-0.5" role="group" aria-label="Clone protocol">
      {#each PROTOCOLS as option (option)}
        <button
          type="button"
          class="h-6 rounded-md px-2.5  font-medium uppercase
            [transition:background-color_var(--duration-quick)_var(--ease-premium),color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
            {store.protocol === option ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground'}"
          aria-pressed={store.protocol === option}
          onclick={() => {
            store.protocol = option;
            if (option === "ssh") void store.checkSshAccess();
          }}
        >
          {option}
        </button>
      {/each}
    </div>
    <p class="min-w-0 flex-1 text-pretty  leading-relaxed text-muted-foreground">
      {#if store.protocol === "https" && store.readiness?.github?.solusToken}
        Uses {store.hostLabel || "this machine"}’s own GitHub sign-in.
      {:else if store.protocol === "https"}
        Public repositories only, until {store.hostLabel || "this machine"} signs in.
      {:else if store.sshKeyMissing}
        <span class="text-(--solus-status-error)">No SSH key on this machine — clone over HTTPS instead.</span>
      {:else if store.sshAccess}
        <span class={store.sshAccess.ok ? "" : "text-(--solus-status-error)"}>{store.sshAccess.message}</span>
      {:else}
        Uses an SSH key that lives on {store.hostLabel || "this machine"}.
      {/if}
    </p>
  </div>
{/if}

<div class="text-xs px-4 pb-1">
  <HostReadinessNotes {store} {localIdentity} />
</div>
