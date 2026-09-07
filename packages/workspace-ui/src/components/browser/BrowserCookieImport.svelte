<script lang="ts">
  import {
    ChevronLeft,
    KeyRound,
    Loader2,
    Lock,
    RefreshCw,
    ShieldAlert,
  } from "@lucide/svelte";
  import type {
    BrowserCookieSource,
    BrowserCookieSourceScan,
  } from "@solus/contracts/browser-types";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { Button } from "../ui/button";
  import {
    blockedSourceDetail,
    browserName,
    importSummary,
    partitionSources,
    sourceDetail,
    type AccessStep,
    type ImportSummary,
  } from "./lib/profiles";

  /**
   * A one-time copy of a browser profile's cookies into one Solus profile
   * (ADR 0025, 0026). Pick a browser, read one sentence, press the button that
   * names what it does: that press is the consent the host requires.
   */

  interface Props {
    serverId: string;
    projectRoot: string | undefined;
    profileId: string;
    profileName: string;
    onBack: () => void;
  }

  let { serverId, projectRoot, profileId, profileName, onBack }: Props =
    $props();

  let scan = $state<BrowserCookieSourceScan | null>(null);
  const sources = $derived(partitionSources(scan?.sources ?? []));
  let scanError = $state<string | null>(null);
  let chosen = $state<BrowserCookieSource | null>(null);
  let importing = $state(false);
  let outcome = $state<ImportSummary | null>(null);
  let failure = $state<string | null>(null);
  /** The blocked source the host was asked to open settings for, and how far the
   *  user has got since. */
  let accessSourceId = $state<string | null>(null);
  let accessStep = $state<AccessStep>("idle");

  let scanToken = 0;

  /** Re-read the host's browsers. The answer changes when a browser writes a
   *  cookie or the user grants a permission, so this runs on open and on demand. */
  function rescan() {
    const token = ++scanToken;
    scan = null;
    scanError = null;
    void browserStore
      .cookieSources(serverId)
      .then((found) => {
        if (token === scanToken) scan = found;
      })
      .catch((error: Error) => {
        if (token === scanToken) scanError = error.message;
      });
  }

  $effect(() => {
    rescan();
    return () => {
      scanToken += 1;
    };
  });

  function stepFor(source: BrowserCookieSource): AccessStep {
    return source.id === accessSourceId ? accessStep : "idle";
  }

  function requestAccess(source: BrowserCookieSource) {
    failure = null;
    void browserStore
      .requestCookieAccess(serverId, source.id)
      .then(() => {
        accessSourceId = source.id;
        accessStep = "requested";
      })
      .catch((error: Error) => {
        failure = error.message;
      });
  }

  function checkAgain() {
    accessStep = "rechecked";
    rescan();
  }

  function runImport() {
    const source = chosen;
    if (!source || importing) return;
    importing = true;
    failure = null;
    void browserStore
      .importCookies(serverId, {
        sourceId: source.id,
        projectRoot,
        profileId,
        consent: true,
      })
      .then((result) => {
        outcome = importSummary(result);
      })
      .catch((error: Error) => {
        failure = error.message;
      })
      .finally(() => {
        importing = false;
      });
  }
</script>

<div class="text-workspace-chrome flex flex-col gap-0.5">
  <div class="flex items-center gap-1 px-1 pt-0.5 pb-1">
    <Button
      variant="ghost"
      size="icon-xs"
      class="rounded-full text-(--solus-text-tertiary)"
      aria-label="Back to browser profiles"
      onclick={onBack}
    >
      <ChevronLeft />
    </Button>
    <span class="min-w-0 truncate font-medium text-(--solus-text-primary)">
      Import cookies
    </span>
  </div>

  {#if outcome}
    <p class="px-2 font-medium text-(--solus-text-primary)">{outcome.headline}</p>
    {#if outcome.detail}
      <p class="px-2 text-(--solus-text-tertiary)">{outcome.detail}</p>
    {/if}
    <p class="px-2 pb-1.5 text-(--solus-text-tertiary)">
      Reload open pages to use them.
    </p>
    <Button variant="outline" size="sm" class="mx-1 mb-1" onclick={onBack}
      >Done</Button
    >
  {:else if scanError}
    <p class="px-2 text-(--solus-text-secondary)">{scanError}</p>
    <Button variant="outline" size="sm" class="mx-1 my-1" onclick={rescan}>
      <RefreshCw />
      Try again
    </Button>
  {:else if !scan}
    <div
      class="flex items-center gap-2 px-2 pb-1.5 text-(--solus-text-tertiary)"
      aria-live="polite"
    >
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
      <span>Looking for browsers…</span>
    </div>
  {:else if !scan.supported}
    <!-- No supported browser at all is a state, not an error. -->
    <p class="px-2 pb-1.5 text-(--solus-text-secondary)">
      {scan.unavailable ?? "Cookie import is not available on this host."}
    </p>
  {:else}
    {#each sources.available as source (source.id)}
      {@const isChosen = chosen?.id === source.id}
      <button
        type="button"
        class="flex h-auto min-h-9 w-full items-center gap-2.5 overflow-hidden rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--wash-2)] disabled:opacity-60 disabled:hover:bg-transparent {isChosen
          ? 'bg-[var(--wash-2)]'
          : ''}"
        aria-pressed={isChosen}
        disabled={source.importable === 0}
        onclick={() => {
          chosen = isChosen ? null : source;
          failure = null;
        }}
      >
        <span class="flex min-w-0 flex-1 flex-col gap-[0.0625rem]">
          <span class="truncate font-medium text-(--solus-text-primary)"
            >{source.label}</span
          >
          <span class="truncate text-(--solus-text-tertiary)"
            >{sourceDetail(source)}</span
          >
        </span>
        {#if source.unlockPrompt}
          <KeyRound
            class="size-3 shrink-0 text-(--solus-text-tertiary)"
            aria-label="Asks for your keychain"
          />
        {/if}
      </button>
    {/each}

    <!-- Found, and refused. Listed with the reason and, where the host can
         open the setting that grants access, the way to do it. -->
    {#each sources.blocked as source (source.id)}
      {@const step = stepFor(source)}
      <div
        class="flex h-auto min-h-9 w-full items-center gap-2.5 rounded-md px-2 py-1"
      >
        <span class="flex min-w-0 flex-1 flex-col gap-[0.0625rem]">
          <span class="flex items-center gap-1.5 truncate text-(--solus-text-secondary)">
            <Lock class="size-3 shrink-0" aria-hidden="true" />
            <span class="truncate font-medium">{source.label}</span>
          </span>
          <span class="text-(--solus-text-tertiary)"
            >{blockedSourceDetail(source, step)}</span
          >
        </span>
        {#if source.canRequestAccess}
          {#if step === "idle"}
            <Button
              variant="outline"
              size="xs"
              class="shrink-0"
              onclick={() => requestAccess(source)}>Allow…</Button
            >
          {:else}
            <Button
              variant="outline"
              size="xs"
              class="shrink-0"
              onclick={checkAgain}
            >
              <RefreshCw />
              Check again
            </Button>
          {/if}
        {/if}
      </div>
    {/each}

    {#if failure && !chosen}
      <p
        class="flex items-start gap-2 px-2 py-1 text-[var(--failure)]"
        aria-live="polite"
      >
        <ShieldAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span class="min-w-0">{failure}</span>
      </p>
    {/if}

    <!-- The consequence, then the button that accepts it. Nothing else. -->
    {#if chosen}
      <div class="mx-1 mt-1 mb-0.5 flex flex-col gap-2 rounded-md bg-[var(--wash-1)] p-2">
        <p class="text-(--solus-text-secondary)">
          Agents using <span class="font-medium text-(--solus-text-primary)"
            >{profileName}</span
          > will be signed in as you wherever {browserName(chosen.browser)} is.
        </p>
        {#if chosen.unlockPrompt}
          <p class="flex items-start gap-1.5 text-(--solus-text-tertiary)">
            <KeyRound class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span class="min-w-0">{chosen.unlockPrompt}</span>
          </p>
        {/if}
        {#if failure}
          <p
            class="flex items-start gap-1.5 text-[var(--failure)]"
            aria-live="polite"
          >
            <ShieldAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0">{failure}</span>
          </p>
        {/if}
        <div class="flex items-center gap-1.5">
          <Button size="sm" disabled={importing} onclick={runImport}>
            {#if importing}
              <Loader2 class="animate-spin" aria-hidden="true" />
            {/if}
            Import {chosen.importable.toLocaleString()} cookies
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={importing}
            onclick={() => (chosen = null)}>Cancel</Button
          >
        </div>
        <p class="text-(--solus-text-tertiary)">
          Cookies only. Clearing browser data undoes it.
        </p>
      </div>
    {/if}
  {/if}
</div>
