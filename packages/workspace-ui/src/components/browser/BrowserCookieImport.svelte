<script lang="ts">
  import { ChevronLeft, KeyRound, Loader2, Lock, ShieldAlert } from "@lucide/svelte";
  import type {
    BrowserCookieSource,
    BrowserCookieSourceScan,
  } from "@solus/contracts/browser-types";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { Button } from "../ui/button";
  import { importSummary, partitionSources, sourceDetail } from "./lib/profiles";

  /**
   * A one-time copy of a browser profile's cookies into one Solus profile
   * (ADR 0025, 0026).
   *
   * The consent is the point of the surface: after an import, an agent driving
   * this profile is signed in as the user everywhere the source was, so the
   * sentence says exactly that and the button is not armed until it is ticked.
   * A source that will make the OS prompt says so before the dialog appears.
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
  let consented = $state(false);
  let importing = $state(false);
  let outcome = $state<string | null>(null);
  let failure = $state<string | null>(null);

  // Re-scanned each time the offer opens: the answer changes when a browser
  // writes a cookie or a permission is granted.
  $effect(() => {
    const host = serverId;
    let cancelled = false;
    scan = null;
    scanError = null;
    void browserStore
      .cookieSources(host)
      .then((found) => {
        if (!cancelled) scan = found;
      })
      .catch((error: Error) => {
        if (!cancelled) scanError = error.message;
      });
    return () => {
      cancelled = true;
    };
  });

  function runImport() {
    const source = chosen;
    if (!source || !consented || importing) return;
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

<div class="text-workspace-chrome flex flex-col gap-1">
  <div class="flex items-center gap-1 px-1 pt-0.5 pb-1">
    <button
      type="button"
      class="flex size-6 shrink-0 items-center justify-center rounded-full text-(--solus-text-tertiary) transition-colors hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary)"
      aria-label="Back to browser profiles"
      onclick={onBack}
    >
      <ChevronLeft class="size-3.5" />
    </button>
    <span class="min-w-0 truncate font-medium text-(--solus-text-primary)">
      Import cookies into {profileName}
    </span>
  </div>

  {#if outcome}
    <p class="px-2 pb-1 text-(--solus-text-secondary)">{outcome}</p>
    <p class="px-2 pb-2 text-(--solus-text-tertiary)">
      Pages already open on this profile need a reload to pick the cookies up.
    </p>
    <Button variant="outline" class="mx-1 mb-1" onclick={onBack}>Done</Button>
  {:else if scanError}
    <p class="px-2 pb-2 text-(--solus-text-secondary)">{scanError}</p>
  {:else if !scan}
    <div
      class="flex items-center gap-2 px-2 pb-2 text-(--solus-text-tertiary)"
      aria-live="polite"
    >
      <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
      <span>Looking for browsers on this host…</span>
    </div>
  {:else if !scan.supported}
    <!-- No supported browser at all is a state, not an error. A server with no
         desktop browser on it is a perfectly ordinary host to be asking. -->
    <p class="px-2 pb-2 text-(--solus-text-secondary)">
      {scan.unavailable ?? "Cookie import is not available on this host."}
    </p>
  {:else}
    <div class="px-2 pb-1 text-(--solus-text-tertiary)">
      Browser profiles on this host
    </div>
    {#each sources.available as source (source.id)}
      <button
        type="button"
        class="flex h-auto min-h-9 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-[var(--wash-2)] {chosen?.id ===
        source.id
          ? 'bg-[var(--wash-2)]'
          : ''}"
        aria-pressed={chosen?.id === source.id}
        onclick={() => (chosen = source)}
      >
        <span class="flex min-w-0 flex-1 flex-col gap-[0.0625rem]">
          <span class="flex min-w-0 items-center gap-1.5">
            <span class="truncate font-medium text-(--solus-text-primary)"
              >{source.label}</span
            >
            {#if source.unlockPrompt}
              <KeyRound
                class="size-3 shrink-0 text-[var(--warning)]"
                aria-label="Needs your keychain"
              />
            {/if}
          </span>
          <span class="truncate text-(--solus-text-tertiary)"
            >{sourceDetail(source)}</span
          >
        </span>
      </button>
    {/each}

    <!-- Found, and refused. Listed with the reason rather than hidden. -->
    {#each sources.blocked as source (source.id)}
      <div
        class="flex h-auto min-h-9 w-full items-start gap-2.5 rounded-md px-2 py-1.5 opacity-70"
      >
        <Lock
          class="mt-0.5 size-3 shrink-0 text-(--solus-text-tertiary)"
          aria-hidden="true"
        />
        <span class="flex min-w-0 flex-1 flex-col gap-[0.0625rem]">
          <span class="truncate font-medium text-(--solus-text-secondary)"
            >{source.label}</span
          >
          <span class="text-(--solus-text-tertiary)">{source.unavailable}</span>
        </span>
      </div>
    {/each}

    <div class="my-1 h-px bg-[var(--hairline)]"></div>

    <!-- Said before the system dialog appears, never after. -->
    {#if chosen?.unlockPrompt}
      <p
        class="flex items-start gap-2 px-2 pb-1.5 text-(--solus-text-secondary)"
      >
        <KeyRound
          class="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]"
          aria-hidden="true"
        />
        <span class="min-w-0">{chosen.unlockPrompt}</span>
      </p>
    {/if}

    <!-- The sentence names the capability being granted, and nothing is armed
         until it is ticked. -->
    <label
      class="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--wash-2)]"
    >
      <input
        type="checkbox"
        class="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)]"
        bind:checked={consented}
      />
      <span class="min-w-0 text-(--solus-text-secondary)">
        I understand that agents driving <span
          class="text-(--solus-text-primary)">{profileName}</span
        > will be signed in as me on every site this browser profile is signed in
        to.
      </span>
    </label>

    {#if failure}
      <p
        class="flex items-start gap-2 px-2 pb-1 text-[var(--failure)]"
        aria-live="polite"
      >
        <ShieldAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span class="min-w-0">{failure}</span>
      </p>
    {/if}

    <Button
      class="mx-1 mb-1"
      disabled={!chosen || !consented || importing}
      onclick={runImport}
    >
      {#if importing}
        <Loader2 class="animate-spin" aria-hidden="true" />
      {/if}
      Copy cookies
    </Button>
    <!-- The way back out, stated where the decision is made. -->
    <p class="px-2 pb-1 text-(--solus-text-tertiary)">
      Cookies only. Saved passwords, history, bookmarks, and site storage are
      never read, and no cookie name, value, or site leaves this host. Clearing
      this profile's browser data undoes the import.
    </p>
  {/if}
</div>
