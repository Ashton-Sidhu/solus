<script lang="ts">
  import { slide } from "svelte/transition";
  import { CircleNotchIcon, GithubLogoIcon, MagnifyingGlassIcon } from "phosphor-svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import type { CloneProtocol } from "../../../shared/types";
  import { abbreviateHome } from "../../lib/paths";
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
  const FIELD =
    "h-[2.125rem] rounded-lg border-0 bg-muted px-2.5 font-mono text-[0.75rem] text-foreground shadow-none focus-visible:ring-0 dark:bg-muted";

  const isClone = $derived(store.source === "clone");
  const showProtocol = $derived(!!store.cloneUrl);
  const destination = $derived(store.destinationPreview);
</script>

{#if isClone}
  <div class="flex flex-col gap-4 border-t border-border px-5 pb-5 pt-[1.125rem]">
    <label class="flex flex-col gap-1.5">
      <span class="text-[0.71875rem] text-muted-foreground">Repository URL</span>
      <Input
        bind:ref={inputEl}
        bind:value={store.query}
        class={FIELD}
        placeholder="https://github.com/org/repo.git"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        dictation={false}
        aria-label="Repository URL"
      />
    </label>

    <div class="flex flex-col gap-1.5">
      <span class="text-[0.71875rem] text-muted-foreground">Destination</span>
      <div class="flex items-center gap-2">
        <!-- Read-only: the host resolves the final path itself, and picking one
             here is what "Choose…" does — it clones straight into that folder. -->
        <span
          class="flex h-[2.125rem] min-w-0 flex-1 items-center truncate rounded-lg bg-muted px-2.5 font-mono text-[0.75rem]
            {destination ? 'text-foreground' : 'text-muted-foreground'}"
          title={destination ?? undefined}
        >
          {abbreviateHome(destination ?? store.projectsRoot)}
        </span>
        <Button variant="outline" class="h-[2.125rem] shrink-0 px-3 text-[0.8125rem]" onclick={onBrowse}>
          Choose…
        </Button>
      </div>
    </div>

    <p class="text-pretty text-[0.71875rem] leading-relaxed text-muted-foreground">
      {#if destination}
        Clones onto {store.hostLabel || "this machine"} as {abbreviateHome(destination)}
      {:else}
        Paste an HTTPS or SSH clone URL — or just <span class="font-mono">owner/repo</span> for GitHub.
      {/if}
    </p>
  </div>
{:else if store.source === "github"}
  <div class="border-t border-border px-3 pb-2 pt-3">
    <label class="mb-1 flex h-[2.125rem] items-center gap-2 rounded-lg bg-muted px-2.5">
      <MagnifyingGlassIcon size={13} class="shrink-0 text-muted-foreground" />
      <Input
        bind:ref={inputEl}
        bind:value={store.query}
        class="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[0.8125rem] text-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
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
      {#if store.readiness?.github.solusLogin}
        <span class="shrink-0 text-[0.6875rem] text-muted-foreground">{store.readiness.github.solusLogin}</span>
      {/if}
    </label>

    {#if store.needsGithubOnHost}
      <div class="flex h-[16.625rem] flex-col items-center justify-center gap-1 px-8 text-center">
        <GithubLogoIcon size={22} weight="fill" class="mb-1 text-muted-foreground" />
        <div class="text-pretty text-[0.8125rem] font-medium">
          {store.hostLabel || "This machine"} isn’t signed in to GitHub
        </div>
        <div class="text-pretty text-[0.75rem] leading-relaxed text-muted-foreground">
          {store.hostIsLocal
            ? "Sign in to browse and clone the repositories you can access."
            : "Each machine keeps its own credentials — nothing carries over from this one."}
        </div>
        {#if store.deviceCode}
          <p class="mt-2 text-[0.75rem] text-foreground">
            Open
            <a class="text-primary underline" href={store.deviceCode.verificationUri} target="_blank" rel="noreferrer">
              {store.deviceCode.verificationUri}
            </a>
            and enter
            <code class="ml-1 rounded-md bg-muted px-1.5 py-0.5 font-mono tracking-widest">
              {store.deviceCode.userCode}
            </code>
          </p>
        {:else}
          <Button
            class="mt-3 px-3.5 text-[0.8125rem]"
            disabled={store.connectingGithub}
            onclick={() => void store.connectGithub()}
          >
            {store.connectingGithub ? "Waiting for GitHub…" : "Connect GitHub"}
          </Button>
        {/if}
      </div>
    {:else}
      <div
        id="open-project-list"
        role="listbox"
        aria-label="Repositories"
        class="hairline-scroll h-[16.625rem] overflow-y-auto pt-1"
      >
        {#if store.reposLoading && store.repos.length === 0}
          <div class="flex h-full items-center justify-center gap-2 text-[0.75rem] text-muted-foreground">
            <CircleNotchIcon size={14} class="animate-spin" />
            Loading repositories…
          </div>
        {:else if store.reposError}
          <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <div class="text-pretty text-[0.75rem] leading-relaxed text-muted-foreground">
              Couldn’t load repositories: {store.reposError}
            </div>
            <Button variant="outline" class="text-[0.8125rem]" onclick={() => void store.loadRepos()}>
              Try again
            </Button>
          </div>
        {:else if store.filteredRepos.length === 0}
          <div class="flex h-full flex-col items-center justify-center gap-1 text-center">
            <div class="text-[0.8125rem] font-medium">Nothing matches “{store.query.trim()}”</div>
            <div class="text-[0.75rem] text-muted-foreground">Try a different search, or clone from a URL.</div>
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
              <span class="min-w-0 flex-1 truncate text-[0.8125rem]">
                <span class="text-muted-foreground">{repo.fullName.split("/")[0]}/</span>{repo.name}
              </span>
              {#if repo.private}
                <span class="shrink-0 text-[0.6875rem] text-muted-foreground">Private</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{/if}

{#if showProtocol}
  <div class="flex items-center gap-2 px-5 pb-1" transition:slide={{ duration: 160 }}>
    <div class="inline-flex h-7 shrink-0 items-center rounded-lg bg-muted p-0.5" role="group" aria-label="Clone protocol">
      {#each PROTOCOLS as option (option)}
        <button
          type="button"
          class="h-6 rounded-md px-2.5 text-[0.6875rem] font-medium uppercase tracking-wide
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
    <p class="min-w-0 flex-1 text-pretty text-[0.71875rem] leading-relaxed text-muted-foreground">
      {#if store.protocol === "https" && store.readiness?.github.solusToken}
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

<div class="px-4 pb-1">
  <HostReadinessNotes {store} {localIdentity} />
</div>

<style>
  /* Matches the folder picker: a hairline thumb over a track that isn't drawn,
     because a dialog this size can't afford chrome-width bars. */
  .hairline-scroll {
    scrollbar-width: thin;
  }
  .hairline-scroll::-webkit-scrollbar {
    width: 0.1875rem;
  }
  .hairline-scroll::-webkit-scrollbar-track {
    background: transparent;
  }
  .hairline-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--solus-text-tertiary) 35%, transparent);
    border-radius: 0.25rem;
  }
</style>
