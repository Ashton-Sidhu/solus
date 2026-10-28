<script lang="ts">
  import { tick } from "svelte";
  import { Link2 as LinkSimpleIcon, X as XIcon } from "@lucide/svelte";
  import { normalizeServerUrl, pairServer, parsePairLink } from "@solus/client-core/pairing";
  import { defaultDeviceLabel } from "@solus/client-core/device-label";
  import { localApi } from "@solus/client-core/local-api";
  import type { SavedServer } from "@solus/client-core/server-registry";
  import { wslHostLabel } from "@solus/contracts/remote-machines";
  import { serversStore, type AddHostMode } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import * as Tabs from "../ui/tabs";
  import { Input } from "../ui/input";
  import { setPopoverLayer } from "../popoverLayer.svelte";
  import PairingBridge from "./PairingBridge.svelte";
  import AddOverSshForm from "./AddOverSshForm.svelte";
  import { addOverSshStore } from "./add-over-ssh.store.svelte";
  import AddWslDistroForm from "./AddWslDistroForm.svelte";
  import { addWslDistroStore } from "./add-wsl-distro.store.svelte";
  import { landInHostList } from "./lib/land-in-host-list";
  import { sshBridgePhase } from "./lib/add-over-ssh";
  import { wslBridgePhase } from "./lib/add-wsl-distro";
  import { pairingPhase, thisDevice, type BridgeMachine } from "./lib/pairing-bridge";
  import { useHostLookup } from "./lib/host-lookup.svelte";
  import { messageFor } from "./lib/setup-rpc";

  const mode = $derived(serversStore.addServerMode);
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
  // The app's popover layer sits below this dialog, so a picker opened from it
  // (the SSH tab's identity file) portals here, above the dialog.
  let popoverLayerEl: HTMLDivElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return popoverLayerEl;
    },
  });

  const device = thisDevice(localApi.getPlatform(), navigator.userAgent);
  const targetUrl = $derived(
    mode === "link" ? (parsePairLink(pairLink)?.url ?? "") : normalizeServerUrl(serverUrl),
  );
  const hostLookup = useHostLookup(() => targetUrl);
  const lookedUpHost = $derived(hostLookup.host);
  const sshTarget = $derived(addOverSshStore.sshTarget.trim());
  const bridgeHost = $derived<BridgeMachine | null>(
    mode === "ssh"
      ? sshTarget ? { name: sshTarget } : null
      : mode === "wsl"
        ? { name: wslHostLabel(addWslDistroStore.distro), os: "linux" }
        : paired ? { name: paired.label, os: paired.os } : lookedUpHost,
  );
  const phase = $derived(
    mode === "ssh"
      ? sshBridgePhase(addOverSshStore)
      : mode === "wsl"
        ? wslBridgePhase(addWslDistroStore.phase)
        : pairingPhase({ targetUrl, host: lookedUpHost, isPairing: busy, isPaired: !!paired, failedUrl }),
  );
  /** The SSH form and the WSL add draw their own controls and focus them. */
  const isMachineAdd = $derived(mode === "ssh" || mode === "wsl");

  // The field of the open tab takes the focus, so typing and Escape reach the
  // dialog and not the composer behind it. The SSH and WSL forms focus their own fields.
  $effect(() => {
    if (!serversStore.addServerOpen || isMachineAdd || paired) return;
    const field = mode === "link" ? linkInput : urlInput;
    void tick().then(() => (field ?? dialog)?.focus());
  });

  function reset() {
    pairLink = "";
    serverUrl = "";
    pairCode = "";
    label = "";
    paired = null;
    failedUrl = null;
    busy = false;
  }

  function close() {
    if (paired && dialog) landInHostList(dialog, paired.id);
    reset();
    addOverSshStore.releaseDraft();
    serversStore.closeAddServer();
  }

  function selectMode(next: AddHostMode) {
    if (next === "ssh") addOverSshStore.ensureDraft();
    serversStore.addServerMode = next;
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

  // An SSH or WSL add in flight keeps the dialog open against a stray click; Escape and Cancel still close it.
  function handleBackdrop(event: MouseEvent) {
    const isAdding = (mode === "ssh" && addOverSshStore.phase === "running") || (mode === "wsl" && addWslDistroStore.phase === "running");
    if (event.target === event.currentTarget && !isAdding) close();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }
</script>

{#if serversStore.addServerOpen}
  <div
    class="text-sm fixed inset-0 z-[10025] flex items-start justify-center px-4 pt-[10vh] pointer-events-auto picker-backdrop"
    role="presentation"
    onclick={handleBackdrop}
    onkeydown={handleKeydown}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-server-title"
      tabindex="-1"
      bind:this={dialog}
      class="@container/add-host w-full max-w-[44rem] outline-none overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow) backdrop-blur-xl"
    >
      <header class="flex items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-3">
        <div class="min-w-0">
          <h2 id="add-server-title" class="truncate  font-medium text-(--solus-text-primary)">Add host</h2>
          <p class="mt-0.5 text-xs text-(--solus-text-tertiary)">
            {#if mode === "ssh"}
              {addOverSshStore.sshHostName} signs in with its SSH keys and installs Solus there.
            {:else if mode === "wsl"}
              {addWslDistroStore.hostName} installs Solus in the distro and keeps it running.
            {:else}
              Pair this desktop with another Solus server.
            {/if}
          </p>
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

      {#if mode === "wsl"}
        <!-- A distro is chosen in the nearby list, so its add has no tabs: only its progress and result. -->
        <div class="px-4 pt-3 pb-4">
          <AddWslDistroForm onclose={close} />
        </div>
      {:else if paired && !isMachineAdd}
        <div class="flex justify-end gap-2 px-4 pt-2 pb-4">
          <button bind:this={doneButton} type="button" class="rounded-lg bg-(--solus-accent) px-3 py-2  font-medium text-(--solus-text-on-accent) transition-transform active:scale-[0.96]" onclick={close}>Done</button>
        </div>
      {:else}
        <div class="px-4 pt-3 pb-4">
          <Tabs.Root
            value={mode}
            class="gap-0"
            onValueChange={(value) => selectMode(value as AddHostMode)}
          >
            <Tabs.List variant="line" class="mb-4 w-full justify-start gap-4 border-b border-border pb-1">
              <Tabs.Trigger value="link" class="flex-none px-0">Pair link</Tabs.Trigger>
              <Tabs.Trigger value="manual" class="flex-none px-0">Code</Tabs.Trigger>
              <Tabs.Trigger value="ssh" class="flex-none px-0">SSH</Tabs.Trigger>
            </Tabs.List>

            {#if mode === "ssh"}
              <Tabs.Content value="ssh" class="mt-0">
                <AddOverSshForm onclose={close} />
              </Tabs.Content>
            {:else}
            <form class="space-y-3" onsubmit={(event) => { event.preventDefault(); void (mode === "link" ? submitLink() : submitManual()); }}>
              <!-- One row in a wide dialog: what reaches the host, then its name. -->
              <div class="grid gap-3 @min-[36rem]/add-host:grid-cols-[1fr_12rem]">
              <Tabs.Content value="link" class="mt-0">
                <label class="block">
                  <span class="text-xs font-medium text-(--solus-text-secondary)">Pairing link</span>
                  <Input bind:ref={linkInput} bind:value={pairLink} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="http://192.168.1.42:3000/pair#token=..." autocomplete="off" />
                </label>
              </Tabs.Content>
              <Tabs.Content value="manual" class="mt-0 grid gap-3 @min-[36rem]/add-host:grid-cols-[1fr_7rem]">
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
              </div>

            <div class="flex justify-end gap-2 pt-1">
              <button type="button" class="rounded-lg px-3 py-2  font-secondary text-(--solus-text-secondary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" onclick={close}>Cancel</button>
              <button type="submit" disabled={busy} class="inline-flex items-center gap-2 rounded-lg bg-(--solus-accent) px-3 py-2  font-medium text-(--solus-text-on-accent) transition-[opacity,transform] active:scale-[0.96] disabled:cursor-wait disabled:opacity-60">
                <LinkSimpleIcon size={14} />
                {busy ? "Pairing..." : "Pair"}
              </button>
            </div>
            </form>
            {/if}
          </Tabs.Root>
        </div>
      {/if}
    </div>
    <div bind:this={popoverLayerEl} class="contents"></div>
  </div>
{/if}
