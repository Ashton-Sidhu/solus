<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Download as DownloadSimpleIcon,
    Link2Off as UnlinkIcon,
    UploadCloud as UploadIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { getPlanStore, getWorkspaceContext } from "../../contexts";
  import type { DocDestination, DocProviderId, DocProviderStatus } from "@solus/contracts/docs";
  import DocDestinationIcon from "./DocDestinationIcon.svelte";
  import DocProviderLogo from "./DocProviderLogo.svelte";
  import { docProviderLabel, docSyncChip, destinationNoun } from "./lib/work-publish";
  import { toasts } from "../../lib/toasts";
  import { buildGoogleDiagramAssets } from "../document-shell/lib/google-diagrams";

  interface Props {
    workId?: string;
    planId?: string;
    getCurrentContent?: () => string;
    flushSave?: () => Promise<void>;
  }

  let { workId, planId, getCurrentContent, flushSave }: Props = $props();

  const session = getWorkspaceContext();
  const store = session.worksStore;
  const planStore = getPlanStore();

  let open = $state(false);
  let busy = $state(false);
  /** The provider whose destinations are being chosen, or null when the menu is
   *  showing its ordinary actions. Only ever set on a first publish. */
  let pickingProvider = $state<DocProviderId | null>(null);
  let destinations = $state<DocDestination[]>([]);
  let destinationsLoading = $state(false);
  let providerStatusesLoading = $state(false);
  let providerStatuses = $state<DocProviderStatus[]>([]);

  const work = $derived(workId ? store.works[workId] : undefined);
  const plan = $derived(planId ? planStore.get(planId) : undefined);
  const link = $derived(work?.mirroredDoc ?? plan?.mirroredDoc);
  const ownerServerId = $derived(
    workId ? store.hostFor(workId) ?? undefined : planId ? planStore.hostFor(planId) ?? undefined : undefined,
  );
  const chip = $derived(docSyncChip(link));

  // Which providers exist is a host fact that can change while this stays
  // mounted (the user connects one in Settings), so it is re-read when the menu
  // opens rather than once at mount.
  $effect(() => {
    if (!open) return;
    providerStatusesLoading = true;
    void store.loadDocProviders(ownerServerId)
      .then((statuses) => (providerStatuses = statuses))
      .finally(() => (providerStatusesLoading = false));
  });

  // Presence-scoped staleness poll: only while a linked document is on screen.
  // Depends on whether a link exists, never on the link object — each refresh
  // writes back a freshly deserialized one, so an object dependency would
  // re-arm the watch on its own answer and loop at request latency.
  const hasLink = $derived(Boolean(link));
  $effect(() => {
    if (!hasLink) return;
    if (workId) return store.watchUpstream(workId);
    if (planId) return planStore.watchUpstream(planId);
  });

  $effect(() => {
    const provider = pickingProvider;
    if (!provider) return;
    void loadDestinations(provider);
  });

  async function loadDestinations(provider: DocProviderId) {
    destinationsLoading = true;
    try {
      destinations = await store.loadDocDestinations(provider, ownerServerId);
    } catch (error) {
      toasts.error(`Couldn't list ${docProviderLabel(provider)} ${destinationNoun(provider)}s`, {
        description: error instanceof Error ? error.message : String(error),
      });
      pickingProvider = null;
    } finally {
      destinationsLoading = false;
    }
  }

  /**
   * Publishing is a background errand, not a modal one. The menu is dismissed
   * before the first request goes out — the user picked a folder, that decision
   * is made — and a progress toast carries the rest. The trigger's "Working…"
   * is the quiet second copy for anyone still looking at the header.
   */
  async function publish(options: { destination?: DocDestination; force?: boolean } = {}) {
    dismiss();
    busy = true;
    const provider = link?.provider ?? options.destination?.provider;
    const where = provider ? docProviderLabel(provider) : "the document";
    const progress = toasts.progress(
      options.destination ? `Publishing to ${where} › ${options.destination.label}…` : `Publishing to ${where}…`,
    );
    try {
      await flushSave?.();
      const content = getCurrentContent?.() ?? work?.content ?? plan?.content ?? "";
      const diagramAssets = provider === "gdrive"
        ? await buildGoogleDiagramAssets(content, (id) => store.ensureContent(id, "document-publish"))
        : [];
      const result = workId
        ? await store.publish(workId, { ...options, diagramAssets })
        : planId
          ? await planStore.publish(planId, { ...options, content, diagramAssets })
          : { ok: false as const, error: "The document is no longer available." };
      if (result.ok) {
        progress.success(`Published to ${docProviderLabel(result.link.provider)}`, {
          description: result.lossyParts?.length
            ? `Not carried into the page: ${result.lossyParts.join(", ")}.`
            : undefined,
          action: { label: "Open", onAction: () => openUpstream(result.link.url) },
        });
        return;
      }
      if (result.conflict) {
        // Not an error: the user chooses. Offering only "OK" here would leave
        // them with a chip and no way forward.
        progress.info("The upstream document changed", {
          description: "Pull it down first, or publish over it.",
          actions: [
            { label: "Pull latest", onAction: () => void pull() },
            { label: "Publish anyway", onAction: () => void publish({ force: true }) },
          ],
        });
        return;
      }
      progress.error("Publish failed", { description: result.error });
    } catch (error) {
      progress.error("Publish failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      busy = false;
    }
  }

  async function pull() {
    dismiss();
    busy = true;
    const progress = toasts.progress(
      link ? `Pulling the latest from ${docProviderLabel(link.provider)}…` : "Pulling the latest…",
    );
    try {
      const result = workId
        ? await store.pullUpstream(workId)
        : planId
          ? await planStore.pullUpstream(planId)
          : { ok: false as const, error: "The document is no longer available." };
      if (!result.ok) {
        progress.error("Couldn't refresh from upstream", { description: result.error });
        return;
      }
      progress.success("Refreshed from upstream", {
        description: result.lossyParts?.length
          ? `Not carried into markdown: ${result.lossyParts.join(", ")}. The previous version is still in History.`
          : workId ? "The previous version is in History." : undefined,
      });
    } finally {
      busy = false;
    }
  }

  /** Close the menu and forget any half-made destination choice, so the next
   *  open starts at the top rather than inside a stale folder list. */
  function dismiss() {
    open = false;
    pickingProvider = null;
  }

  /**
   * The upstream page belongs in the user's browser, where they are already
   * signed in to Atlassian or Google — not in an Electron window with its own
   * session. `localApi` resolves that per surface: the native shell on desktop,
   * a new tab on web and mobile.
   */
  function openUpstream(url: string) {
    void localApi.openExternal(url);
  }

  /**
   * A provider the user could sign in to is a route, not a dead end. Settings
   * opens on its own selected host rather than this document's — there is no
   * host-preselect API — so the row names the provider and Settings names the
   * host.
   */
  function openProviderSettings() {
    open = false;
    session.showSettings("providers");
  }

  async function unlink() {
    if (workId) await store.unlinkUpstream(workId);
    else if (planId) await planStore.unlinkUpstream(planId);
    toasts.info("Stopped tracking the upstream document", {
      description: "The page itself was not changed.",
    });
  }
</script>

{#if work?.type === "doc" || plan}
  <!-- Escape and click-away are closes too: without this, reopening lands back
       inside a stale folder list instead of at "Publish to". -->
  <DropdownMenu.Root bind:open onOpenChange={(next) => { if (!next) pickingProvider = null; }}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="wpm-verb"
          class:wpm-verb--pending={chip.tone === "pending"}
          class:wpm-verb--warning={chip.tone === "warning"}
          class:wpm-verb--error={chip.tone === "error"}
          data-testid="work-publish-menu"
          title={chip.title}
        >
          {#if link}<DocProviderLogo provider={link.provider} size={12} />{/if}
          {busy ? "Working…" : chip.label}
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <!-- Width is declared here, not by the longest folder name: a Drive can hold
         a "_ARCBEAM Brand Guidelines & Assets – November 2025", and `w-auto`
         let one such name stretch the menu past the window.
         `whitespace-nowrap` gives it an intrinsic width from its longest reason
         line ("No Atlassian site is connected. Connect in Settings…"), which on
         a 393px phone anchored near the right edge put it 47px off-screen.
         Touch takes the viewport width and wraps instead: the reason is the
         part that has to stay readable. -->
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={6}
      collisionPadding={8}
      class="w-auto min-w-56 max-w-[min(22rem,calc(100vw-2rem))] whitespace-nowrap pointer-coarse:w-[calc(100vw-2rem)] pointer-coarse:max-w-[calc(100vw-2rem)] pointer-coarse:whitespace-normal"
    >
      {#if pickingProvider}
        <DropdownMenu.Label>
          Choose a {docProviderLabel(pickingProvider)}
          {destinationNoun(pickingProvider)}
        </DropdownMenu.Label>
        {#if destinationsLoading}
          <DropdownMenu.Item disabled class="text-workspace-chrome">Loading…</DropdownMenu.Item>
        {:else if destinations.length === 0}
          <DropdownMenu.Item disabled class="text-workspace-chrome">
            No {destinationNoun(pickingProvider)} is reachable with this connection
          </DropdownMenu.Item>
        {:else}
          <!-- A Drive routinely holds a hundred folders, so the list is the part
               that scrolls — never the whole menu, or Back scrolls away with it.
               The height ceiling is whatever the window leaves below the
               trigger, less the room the label and Back row already take. -->
          <div
            class="max-h-[min(18rem,calc(var(--bits-dropdown-menu-content-available-height,24rem)-6rem))] overflow-y-auto overscroll-contain"
          >
            {#each destinations as destination (destination.scope)}
              <!-- Disabled while a publish is in flight: a first publish creates
                   the document, so a second one would leave an orphan copy the
                   link never points at. -->
              <DropdownMenu.Item
                class="text-workspace-chrome"
                disabled={busy}
                onSelect={() => void publish({ destination })}
              >
                <DocDestinationIcon {destination} />
                <span class="min-w-0 flex-1 truncate text-left" title={destination.label}>{destination.label}</span>
              </DropdownMenu.Item>
            {/each}
          </div>
        {/if}
        <DropdownMenu.Separator />
        <DropdownMenu.Item class="text-workspace-chrome" closeOnSelect={false} onSelect={() => (pickingProvider = null)}>
          Back
        </DropdownMenu.Item>
      {:else if link}
        <DropdownMenu.Label>{docProviderLabel(link.provider)}</DropdownMenu.Label>
        <DropdownMenu.Item class="text-workspace-chrome" data-testid="publish-work" disabled={busy} onSelect={() => void publish()}>
          <UploadIcon size={14} />
          <span class="flex-1 text-left">
            {link.syncState === "conflict" || link.syncState === "upstream_changed" ? "Publish anyway" : "Publish update"}
          </span>
        </DropdownMenu.Item>
        <DropdownMenu.Item class="text-workspace-chrome" data-testid="pull-work" disabled={busy} onSelect={() => void pull()}>
          <DownloadSimpleIcon size={14} /><span class="flex-1 text-left">Pull latest</span>
        </DropdownMenu.Item>
        <DropdownMenu.Item class="text-workspace-chrome" data-testid="open-upstream" onSelect={() => openUpstream(link.url)}>
          <ArrowSquareOutIcon size={14} /><span class="flex-1 text-left">Open in {docProviderLabel(link.provider)}</span>
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item class="text-workspace-chrome" data-testid="unlink-work" onSelect={() => void unlink()}>
          <UnlinkIcon size={14} /><span class="flex-1 text-left">Unlink</span>
        </DropdownMenu.Item>
      {:else}
        <DropdownMenu.Label>Publish to</DropdownMenu.Label>
        {#if providerStatusesLoading}
          <DropdownMenu.Item disabled class="text-workspace-chrome">Checking connections…</DropdownMenu.Item>
        {:else if providerStatuses.length === 0}
          <DropdownMenu.Item disabled class="text-workspace-chrome">No document provider is available.</DropdownMenu.Item>
        {:else}
          <!-- Every provider is listed, connected or not. An absent row reads as
               "Solus cannot do this", which sent people looking in the wrong
               place; a row that states why is the whole point. -->
          {#each providerStatuses as status (status.provider)}
            {#if status.connected}
              <DropdownMenu.Item
                class="text-workspace-chrome"
                data-testid={`publish-to-${status.provider}`}
                closeOnSelect={false}
                onSelect={() => (pickingProvider = status.provider)}
              >
                <UploadIcon size={14} />
                <span class="flex-1 text-left">{docProviderLabel(status.provider)}…</span>
              </DropdownMenu.Item>
            {:else if status.connectable}
              <DropdownMenu.Item
                class="h-auto py-1.5 text-workspace-chrome"
                data-testid={`connect-${status.provider}`}
                onSelect={openProviderSettings}
              >
                <UploadIcon size={14} />
                <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                  <span>{docProviderLabel(status.provider)}</span>
                  <span class="max-w-full whitespace-normal text-(--solus-text-tertiary)">
                    {status.reason} Connect in Settings…
                  </span>
                </span>
              </DropdownMenu.Item>
            {:else}
              <DropdownMenu.Item class="h-auto py-1.5 text-workspace-chrome" data-testid={`unavailable-${status.provider}`} disabled>
                <UploadIcon size={14} />
                <span class="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                  <span>{docProviderLabel(status.provider)}</span>
                  <span class="max-w-full whitespace-normal text-(--solus-text-tertiary)">{status.reason}</span>
                </span>
              </DropdownMenu.Item>
            {/if}
          {/each}
        {/if}
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<style>
  /* Matches the header's other verbs (see WorkHeaderActions .wha-verb): the
     cluster has to read as one row of words, with tone reserved for the states
     that need a decision. */
  .wpm-verb {
    flex-shrink: 0;
    height: 1.5rem;
    padding: 0 0.4375rem;
    border-radius: 0.375rem;
    font-family: inherit;
    font-size: var(--text-chrome-dense);
    font-weight: 400;
    color: var(--solus-text-tertiary);
    background: transparent;
    border: none;
    cursor: pointer;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium);
  }
  .wpm-verb:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .wpm-verb:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border);
    outline-offset: 0.0625rem;
  }
  .wpm-verb--pending {
    color: var(--solus-text-secondary);
  }
  .wpm-verb--warning {
    color: var(--solus-status-running);
  }
  .wpm-verb--error {
    color: var(--solus-status-error);
  }

  @media (max-width: 767px) {
    .wpm-verb {
      height: 2.5rem;
      padding: 0 0.75rem;
      border-radius: 0.5rem;
    }
  }
</style>
