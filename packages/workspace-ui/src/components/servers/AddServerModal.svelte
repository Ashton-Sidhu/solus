<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Link2 as LinkSimpleIcon, X as XIcon } from "@lucide/svelte";
  import { normalizeServerUrl, pairServer, parsePairLink } from "@solus/client-core/pairing";
  import { defaultDeviceLabel } from "@solus/client-core/device-label";
  import { localApi } from "@solus/client-core/local-api";
  import type { SavedServer } from "@solus/client-core/server-registry";
  import { serversStore } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import * as Tabs from "../ui/tabs";
  import { Input } from "../ui/input";
  import PairingBridge from "./PairingBridge.svelte";
  import { landInHostList } from "./lib/land-in-host-list";
  import { pairingPhase, thisDevice, type BridgeMachine } from "./lib/pairing-bridge";
  import { useHostLookup } from "./lib/host-lookup.svelte";
  import { messageFor } from "./lib/setup-rpc";

  type Mode = "link" | "manual";

  let mode = $state<Mode>("link");
  let pairLink = $state("");
  let serverUrl = $state("");
  let pairCode = $state("");
  let label = $state("");
  let busy = $state(false);
  let paired = $state<SavedServer | null>(null);
  let failedUrl = $state<string | null>(null);
  let linkInput: HTMLInputElement | null = $state(null);
  let urlInput: HTMLInputElement | null = $state(null);
  let doneButton: HTMLButtonElement | null = $state(null);
  let dialog: HTMLDivElement | null = $state(null);
  let wasOpen = false;

  const device = thisDevice(localApi.getPlatform(), navigator.userAgent);
  const targetUrl = $derived(
    mode === "link" ? (parsePairLink(pairLink)?.url ?? "") : normalizeServerUrl(serverUrl),
  );
  const hostLookup = useHostLookup(() => targetUrl);
  const lookedUpHost = $derived(hostLookup.host);
  const bridgeHost = $derived<BridgeMachine | null>(
    paired ? { name: paired.label, os: paired.os } : lookedUpHost,
  );
  const phase = $derived(
    pairingPhase({ targetUrl, host: lookedUpHost, isPairing: busy, isPaired: !!paired, failedUrl }),
  );

  function reset() {
    pairLink = "";
    serverUrl = "";
    pairCode = "";
    label = "";
    paired = null;
    failedUrl = null;
    busy = false;
    mode = "link";
  }

  function close() {
    if (paired && dialog) landInHostList(dialog, paired.id);
    reset();
    serversStore.closeAddServer();
  }

  async function submitLink() {
    const parsed = parsePairLink(pairLink);
    if (!parsed) {
      toasts.error("Paste a pairing link like http://host:port/pair#token=...");
      return;
    }
    await pair(parsed.url, parsed.pairToken);
  }

  async function submitManual() {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const code = pairCode.trim();
    // An empty code is a request to join as a device the host already trusts
    // (its local network, when the host allows it); the host answers if not.
    if (!normalizedUrl || (code && !/^\d{6}$/.test(code))) {
      toasts.error("Enter a server address and 6-digit pairing code.");
      return;
    }
    await pair(normalizedUrl, code || undefined);
  }

  async function pair(url: string, pairToken: string | undefined) {
    busy = true;
    try {
      const result = await pairServer({
        url,
        pairToken,
        deviceLabel: defaultDeviceLabel(),
        serverLabel: label.trim(),
        reportedName: lookedUpHost?.name,
      });
      serversStore.savePairedServer(result.server);
      paired = result.server;
      void tick().then(() => doneButton?.focus());
    } catch (err) {
      failedUrl = targetUrl;
      toasts.error("Couldn't pair server", { description: messageFor(err) });
    } finally {
      busy = false;
    }
  }

  function handleBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) close();
  }
</script>

{#if serversStore.addServerOpen}
  <div
    class="text-sm fixed inset-0 z-[10025] flex items-start justify-center px-4 pt-[10vh] pointer-events-auto picker-backdrop"
    role="presentation"
    onclick={handleBackdrop}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-server-title"
      bind:this={dialog}
      class="w-full max-w-[28rem] overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow) backdrop-blur-xl"
    >
      <header class="flex items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-3">
        <div class="min-w-0">
          <h2 id="add-server-title" class="truncate  font-medium text-(--solus-text-primary)">Add server</h2>
          <p class="mt-0.5 text-xs text-(--solus-text-tertiary)">Pair this desktop with another Solus server.</p>
        </div>
        <button
          type="button"
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)"
          aria-label="Close"
          onclick={close}
        >
          <XIcon size={16} />
        </button>
      </header>

      <div class="px-4 pt-4">
        <PairingBridge {phase} {device} host={bridgeHost} />
      </div>

      {#if paired}
        <div class="flex justify-end gap-2 px-4 pt-2 pb-4">
          <button bind:this={doneButton} type="button" class="rounded-lg bg-(--solus-accent) px-3 py-2  font-medium text-(--solus-text-on-accent) transition-transform active:scale-[0.96]" onclick={close}>Done</button>
        </div>
      {:else}
        <div class="px-4 pt-3 pb-4">
          <Tabs.Root
            value={mode}
            class="gap-0"
            onValueChange={(value) => {
              mode = value as Mode;
            }}
          >
            <Tabs.List class="mb-4 grid h-auto w-full grid-cols-2 gap-1 rounded-lg bg-(--solus-surface-hover) p-1">
              <Tabs.Trigger value="link" class="h-auto rounded-lg border-0 px-3 py-2  font-medium text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:text-(--solus-text-primary) active:scale-[0.96] data-active:bg-(--solus-popover-bg) data-active:text-(--solus-text-primary) data-active:shadow-sm">Pair link</Tabs.Trigger>
              <Tabs.Trigger value="manual" class="h-auto rounded-lg border-0 px-3 py-2  font-medium text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:text-(--solus-text-primary) active:scale-[0.96] data-active:bg-(--solus-popover-bg) data-active:text-(--solus-text-primary) data-active:shadow-sm">Code</Tabs.Trigger>
            </Tabs.List>

            <form class="space-y-3" onsubmit={(event) => { event.preventDefault(); void (mode === "link" ? submitLink() : submitManual()); }}>
              <Tabs.Content value="link" class="mt-0">
                <label class="block">
                  <span class="text-xs font-medium text-(--solus-text-secondary)">Pairing link</span>
                  <Input bind:ref={linkInput} bind:value={pairLink} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="http://192.168.1.42:3000/pair#token=..." autocomplete="off" />
                </label>
              </Tabs.Content>
              <Tabs.Content value="manual" class="mt-0 space-y-3">
                <label class="block">
                  <span class="text-xs font-medium text-(--solus-text-secondary)">Server address</span>
                  <Input bind:ref={urlInput} bind:value={serverUrl} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="192.168.1.42:3000" autocomplete="off" />
                </label>
                <label class="block">
                  <span class="text-xs font-medium text-(--solus-text-secondary)">Pair code</span>
                  <Input bind:value={pairCode} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="000000" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
                </label>
              </Tabs.Content>

            <label class="block">
              <span class="text-xs font-medium text-(--solus-text-secondary)">Server name</span>
              <Input bind:value={label} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder={lookedUpHost?.name ?? "Studio Mac"} autocomplete="off" />
            </label>

            <div class="flex justify-end gap-2 pt-1">
              <button type="button" class="rounded-lg px-3 py-2  font-secondary text-(--solus-text-secondary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" onclick={close}>Cancel</button>
              <button type="submit" disabled={busy} class="inline-flex items-center gap-2 rounded-lg bg-(--solus-accent) px-3 py-2  font-medium text-(--solus-text-on-accent) transition-[opacity,transform] active:scale-[0.96] disabled:cursor-wait disabled:opacity-60">
                <LinkSimpleIcon size={14} />
                {busy ? "Pairing..." : "Pair"}
              </button>
            </div>
            </form>
          </Tabs.Root>
        </div>
      {/if}
    </div>
  </div>
{/if}
