<script lang="ts">
  import { tick } from "svelte";
  import { CheckCircleIcon, LinkSimpleIcon, XIcon } from "phosphor-svelte";
  import { desktopDeviceLabel, normalizeServerUrl, pairServer, parsePairLink, urlHost } from "@client-core/pairing";
  import type { SavedServer } from "@client-core/server-registry";
  import { serversStore } from "./servers.store.svelte";
  import * as Tabs from "../ui/tabs";
  import { Input } from "../ui/input";

  type Mode = "link" | "manual";

  let mode = $state<Mode>("link");
  let pairLink = $state("");
  let serverUrl = $state("");
  let pairCode = $state("");
  let label = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);
  let paired = $state<SavedServer | null>(null);
  let linkInput: HTMLInputElement | null = $state(null);
  let urlInput: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (!serversStore.addServerOpen) return;
    if (serversStore.addServerUrl) {
      mode = "manual";
      serverUrl = serversStore.addServerUrl;
      label = label || urlHost(serversStore.addServerUrl);
    }
    void tick().then(() => {
      if (mode === "link") linkInput?.focus();
      else urlInput?.focus();
    });
  });

  function reset() {
    pairLink = "";
    serverUrl = "";
    pairCode = "";
    label = "";
    error = null;
    paired = null;
    busy = false;
    mode = "link";
  }

  function close() {
    reset();
    serversStore.closeAddServer();
  }

  async function submitLink() {
    const parsed = parsePairLink(pairLink);
    if (!parsed) {
      error = "Paste a pairing link like http://host:port/pair#token=...";
      return;
    }
    await pair(parsed.url, parsed.pairToken);
  }

  async function submitManual() {
    const normalizedUrl = normalizeServerUrl(serverUrl);
    if (!normalizedUrl || !/^\d{6}$/.test(pairCode.trim())) {
      error = "Enter a server address and 6-digit pairing code.";
      return;
    }
    await pair(normalizedUrl, pairCode.trim());
  }

  async function pair(url: string, pairToken: string) {
    busy = true;
    error = null;
    try {
      const result = await pairServer({
        url,
        pairToken,
        deviceLabel: desktopDeviceLabel(),
        serverLabel: label.trim() || urlHost(url),
      });
      serversStore.savePairedServer(result.server);
      paired = result.server;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function switchNow() {
    if (!paired) return;
    serversStore.addServerOpen = false;
    serversStore.switchTo(paired.id);
  }

  function handleBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) close();
  }
</script>

{#if serversStore.addServerOpen}
  <div
    class="fixed inset-0 z-[10025] flex items-start justify-center bg-black/[0.05] px-4 pt-[10vh] pointer-events-auto [.dark_&]:bg-black/35"
    role="presentation"
    onclick={handleBackdrop}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-server-title"
      class="w-full max-w-[28rem] overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow) backdrop-blur-xl"
    >
      <header class="flex items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-3">
        <div class="min-w-0">
          <h2 id="add-server-title" class="truncate text-[0.9375rem] font-semibold text-(--solus-text-primary)">Add server</h2>
          <p class="mt-0.5 text-[0.75rem] text-(--solus-text-tertiary)">Pair this desktop with another Solus server.</p>
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

      {#if paired}
        <div class="space-y-4 px-4 py-4">
          <div class="flex items-start gap-3 rounded-xl bg-(--solus-accent-light) p-3 text-(--solus-text-primary)">
            <CheckCircleIcon size={18} class="mt-0.5 shrink-0 text-(--solus-status-complete)" />
            <div class="min-w-0">
              <div class="text-[0.8125rem] font-medium">Server paired</div>
              <div class="mt-1 break-all font-mono text-[0.6875rem] text-(--solus-text-tertiary)">
                {paired.installationId ?? paired.id}
              </div>
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="rounded-lg px-3 py-2 text-[0.8125rem] text-(--solus-text-secondary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" onclick={close}>Done</button>
            <button type="button" class="rounded-lg bg-(--solus-accent) px-3 py-2 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-transform active:scale-[0.96]" onclick={switchNow}>Switch now</button>
          </div>
        </div>
      {:else}
        <div class="px-4 py-4">
          <Tabs.Root
            value={mode}
            class="gap-0"
            onValueChange={(value) => {
              mode = value as Mode;
              error = null;
            }}
          >
            <Tabs.List class="mb-4 grid h-auto w-full grid-cols-2 gap-1 rounded-xl bg-(--solus-surface-hover) p-1">
              <Tabs.Trigger value="link" class="h-auto rounded-lg border-0 px-3 py-2 text-[0.8125rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:text-(--solus-text-primary) active:scale-[0.96] data-active:bg-(--solus-popover-bg) data-active:text-(--solus-text-primary) data-active:shadow-sm">Pair link</Tabs.Trigger>
              <Tabs.Trigger value="manual" class="h-auto rounded-lg border-0 px-3 py-2 text-[0.8125rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color,transform] hover:text-(--solus-text-primary) active:scale-[0.96] data-active:bg-(--solus-popover-bg) data-active:text-(--solus-text-primary) data-active:shadow-sm">Code</Tabs.Trigger>
            </Tabs.List>

            <form class="space-y-3" onsubmit={(event) => { event.preventDefault(); void (mode === "link" ? submitLink() : submitManual()); }}>
              <Tabs.Content value="link" class="mt-0">
                <label class="block">
                  <span class="text-[0.75rem] font-medium text-(--solus-text-secondary)">Pairing link</span>
                  <Input bind:ref={linkInput} bind:value={pairLink} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-[0.8125rem] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="http://192.168.1.42:51234/pair#token=..." autocomplete="off" />
                </label>
              </Tabs.Content>
              <Tabs.Content value="manual" class="mt-0 space-y-3">
                <label class="block">
                  <span class="text-[0.75rem] font-medium text-(--solus-text-secondary)">Server address</span>
                  <Input bind:ref={urlInput} bind:value={serverUrl} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-[0.8125rem] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="192.168.1.42:51234" autocomplete="off" />
                </label>
                <label class="block">
                  <span class="text-[0.75rem] font-medium text-(--solus-text-secondary)">Pair code</span>
                  <Input bind:value={pairCode} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 font-mono text-[0.8125rem] tracking-[0.16em] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="000000" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
                </label>
              </Tabs.Content>

            <label class="block">
              <span class="text-[0.75rem] font-medium text-(--solus-text-secondary)">Server name</span>
              <Input bind:value={label} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 text-[0.8125rem] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="Studio Mac" autocomplete="off" />
            </label>

            {#if error}
              <div class="rounded-lg bg-(--solus-status-error-bg) px-3 py-2 text-[0.75rem] text-(--solus-status-error)">{error}</div>
            {/if}

            <div class="flex justify-end gap-2 pt-1">
              <button type="button" class="rounded-lg px-3 py-2 text-[0.8125rem] text-(--solus-text-secondary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" onclick={close}>Cancel</button>
              <button type="submit" disabled={busy} class="inline-flex items-center gap-2 rounded-lg bg-(--solus-accent) px-3 py-2 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,transform] active:scale-[0.96] disabled:cursor-wait disabled:opacity-60">
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
