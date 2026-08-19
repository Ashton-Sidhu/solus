<script lang="ts">
  import {
    ArrowRightIcon,
    CheckIcon,
    LinkSimpleIcon,
    WifiHighIcon,
    XIcon,
  } from "phosphor-svelte";
  import {
    discoveredServerUrl,
    hostStatusDotClass,
    hostStatusLabel,
    runtime,
    serversStore,
    type NearbyHost,
    type ServerItem,
  } from "@solus/workspace-ui/contexts";
  import { hostOnboardingStore } from "@solus/workspace-ui/components/servers/host-onboarding.store.svelte";
  import { defaultDeviceLabel, urlHost } from "@solus/client-core/pairing";
  import { requestInputFocus } from "@solus/workspace-ui/lib/inputFocus";
  import { registerBackOverlay } from "../lib/back-stack.svelte";
  import { addHostFromInput } from "../lib/add-host";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { classifyConnectInput } from "../lib/connect";
  import { toasts } from "@solus/workspace-ui/lib/toasts";
  import { webState } from "../lib/web-state.svelte";
  import MobileSheet from "./MobileSheet.svelte";

  const open = $derived(webState.serverSetupOpen);
  const isMobile = $derived(runtime.isMobileViewport);

  const savedHosts = $derived(serversStore.servers);

  let smartInput = $state("");
  let codeInput = $state("");
  let labelInput = $state("");
  let busy = $state(false);
  let smartInputEl: HTMLInputElement | null = $state(null);

  // One smart field: a pasted pairing link carries its own token; a bare
  // address still needs the 6-digit code the host shows in Settings.
  const needsCode = $derived(classifyConnectInput(smartInput).kind === "address");

  // Reachability is the whole question this surface answers, so re-probe every
  // time it opens instead of trusting the verdict from the last time.
  $effect(() => {
    if (open) void serversStore.scanForServers();
  });

  // Desktop opens with the field ready for a pasted link. A phone would only
  // get its keyboard thrown up over the list of hosts.
  $effect(() => {
    if (!open || isMobile) return;
    const timer = setTimeout(() => smartInputEl?.focus(), 60);
    return () => clearTimeout(timer);
  });

  registerBackOverlay(
    "server-setup",
    () => isMobile && webState.serverSetupOpen,
    () => close(),
  );

  function close() {
    webState.closeServerSetup();
    requestInputFocus();
  }

  function chooseHost(host: ServerItem) {
    // In place: the chosen host becomes the new-work default; every host's
    // sessions stay mounted and connected throughout.
    close();
    serversStore.switchTo(host.id);
  }

  function pairNearby(host: NearbyHost) {
    close();
    hostOnboardingStore.openForDiscovered(host.server);
  }

  async function submit(event: Event) {
    event.preventDefault();
    busy = true;
    try {
      const server = await addHostFromInput({
        input: smartInput,
        code: codeInput,
        serverLabel: labelInput,
      });
      // In place (dispatch-client step 5): the new host joins the catalog,
      // gets its eager supervisor, and becomes the new-work default — the
      // workspace never reloads for a pairing.
      serversStore.savePairedServer(server);
      serverConnections.startCatalogSupervisors();
      serversStore.switchTo(server.id);
      busy = false;
      webState.closeServerSetup();
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err));
      busy = false;
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet sectionLabel(text: string)}
  <span
    class="mb-1 block px-1 text-xs font-semibold uppercase tracking-[0.03em] text-(--solus-text-tertiary)"
    >{text}</span
  >
{/snippet}

{#snippet hostRow(host: ServerItem)}
  <button
    type="button"
    class="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-[var(--duration-quick)] hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-surface-hover) focus-visible:outline-none"
    onclick={() => chooseHost(host)}
  >
    <span
      class="size-2 shrink-0 rounded-full {hostStatusDotClass(host.status)}"
      aria-hidden="true"
    ></span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span
        class="truncate text-sm font-medium text-(--solus-text-primary)"
        >{host.label}</span
      >
      <span
        class="truncate font-mono text-xs text-(--solus-text-tertiary)"
      >
        {urlHost(host.url)} · {hostStatusLabel(host.status)}
      </span>
    </span>
    {#if host.local}
      <CheckIcon size={14} class="shrink-0 text-(--solus-accent)" />
    {:else}
      <ArrowRightIcon
        size={14}
        class="shrink-0 text-(--solus-text-quaternary) opacity-0 transition-opacity duration-[var(--duration-quick)] group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    {/if}
  </button>
{/snippet}

{#snippet nearbyRow(host: NearbyHost)}
  <button
    type="button"
    class="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-[var(--duration-quick)] hover:bg-(--solus-surface-hover) focus-visible:bg-(--solus-surface-hover) focus-visible:outline-none"
    onclick={() => pairNearby(host)}
  >
    <WifiHighIcon
      size={14}
      class="shrink-0 text-(--solus-text-tertiary)"
    />
    <span class="flex min-w-0 flex-1 flex-col">
      <span
        class="truncate text-sm font-medium text-(--solus-text-primary)"
        >{host.server.name}</span
      >
      <span
        class="truncate font-mono text-xs text-(--solus-text-tertiary)"
        >{urlHost(discoveredServerUrl(host.server))}</span
      >
    </span>
    <span class="shrink-0 text-xs font-medium text-(--solus-accent)"
      >Connect</span
    >
  </button>
{/snippet}

{#snippet body()}
  <div class="flex flex-col gap-4">
    {#if savedHosts.length > 0}
      <section>
        {@render sectionLabel("Your hosts")}
        <div
          class="flex flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)/40 p-1"
        >
          {#each savedHosts as host (host.id)}
            {@render hostRow(host)}
          {/each}
        </div>
      </section>
    {/if}

    {#if serversStore.nearbyHosts.length > 0}
      <section>
        {@render sectionLabel("Nearby")}
        <div
          class="flex flex-col overflow-hidden rounded-2xl border border-(--solus-container-border) bg-(--solus-surface-hover)/40 p-1"
        >
          {#each serversStore.nearbyHosts as host (host.server.installationId)}
            {@render nearbyRow(host)}
          {/each}
        </div>
      </section>
    {/if}

    <section>
      {@render sectionLabel(savedHosts.length > 0 ? "Add a host" : "Connect")}
      <form class="flex flex-col gap-2.5" onsubmit={submit}>
        <p
          class="rounded-lg bg-(--solus-surface-hover) px-3 py-2 text-xs leading-relaxed text-(--solus-text-tertiary)"
        >
          On your computer, open Solus and go to <strong
            class="font-medium text-(--solus-text-secondary)"
            >Settings → Connections</strong
          >. Scan the QR code, or paste the pairing link or address here.
        </p>

        <label class="block">
          <span
            class="text-xs font-medium text-(--solus-text-secondary)"
            >Pairing link or address</span
          >
          <input
            bind:this={smartInputEl}
            bind:value={smartInput}
            type="text"
            class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-sm text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
            placeholder="192.168.1.42:51234 or pairing link"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
          />
        </label>

        {#if needsCode}
          <label class="block">
            <span
              class="text-xs font-medium text-(--solus-text-secondary)"
              >Code</span
            >
            <input
              bind:value={codeInput}
              type="text"
              class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-sm tracking-[0.16em] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
              placeholder="000000"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
            />
          </label>
        {/if}

        <label class="block">
          <span class="text-xs font-medium text-(--solus-text-secondary)">
            Device name
            <span class="font-normal text-(--solus-text-tertiary)">optional</span
            >
          </span>
          <input
            bind:value={labelInput}
            type="text"
            class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-sm text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
            placeholder={defaultDeviceLabel()}
            autocomplete="off"
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          class="inline-flex items-center justify-center gap-2 rounded-lg bg-(--solus-accent) px-3 py-2 text-sm font-medium text-(--solus-text-on-accent) transition-[opacity,transform] active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
        >
          <LinkSimpleIcon size={14} />
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </section>
  </div>
{/snippet}

{#if isMobile}
  <MobileSheet {open} onClose={close} title="Connect a host">
    <div class="pb-2">{@render body()}</div>
  </MobileSheet>
{:else if open}
  <!-- Backdrop click dismisses; the dialog itself stops the bubble. -->
  <div
    class="fixed inset-0 z-[10025] flex items-start justify-center bg-black/[0.05] px-4 pt-[10vh] [.dark_&]:bg-black/35"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="server-setup-title"
      class="max-h-[80vh] w-full max-w-[26rem] overflow-y-auto rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow) backdrop-blur-xl"
    >
      <header
        class="flex items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-3"
      >
        <div class="min-w-0">
          <h2
            id="server-setup-title"
            class="truncate text-sm font-semibold text-(--solus-text-primary)"
          >
            Connect a host
          </h2>
          <p class="mt-0.5 text-xs text-(--solus-text-tertiary)">
            Choose the machine your sessions run on.
          </p>
        </div>
        <button
          type="button"
          class="flex size-9 shrink-0 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
          aria-label="Close"
          onclick={close}
        >
          <XIcon size={14} />
        </button>
      </header>
      <div class="px-4 py-4">{@render body()}</div>
    </div>
  </div>
{/if}
