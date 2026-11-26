<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import { tick, untrack } from "svelte";
  import { CircleAlert, Link2 as LinkSimpleIcon, X as XIcon } from "@lucide/svelte";
  import { normalizeServerUrl, pairServer, parsePairLink } from "@solus/client-core/pairing";
  import { defaultDeviceLabel } from "@solus/client-core/device-label";
  import { localApi } from "@solus/client-core/local-api";
  import type { KnownHost } from "@solus/client-core/known-host";
  import { wslHostLabel } from "@solus/contracts/remote-machines";
  import { serversStore, type AddHostMode } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import * as Tabs from "../ui/tabs";
  import { Input } from "../ui/input";
  import { setPopoverLayer } from "../popoverLayer.svelte";
  import PairingBridge from "./PairingBridge.svelte";
  import SyncSettingsCheckbox from "../connections/SyncSettingsCheckbox.svelte";
  import AddOverSshForm from "./AddOverSshForm.svelte";
  import { addOverSshStore } from "./add-over-ssh.store.svelte";
  import AddWslDistroForm from "./AddWslDistroForm.svelte";
  import { addWslDistroStore } from "./add-wsl-distro.store.svelte";
  import { approvalRequestStore } from "./approval-request.store.svelte";
  import { Button } from "../ui/button";
  import { landInHostList } from "./lib/land-in-host-list";
  import { sshBridgePhase } from "./lib/add-over-ssh";
  import { wslBridgePhase } from "./lib/add-wsl-distro";
  import { pairingPhase, thisDevice, type BridgeMachine } from "./lib/pairing-bridge";
  import { useHostLookup } from "./lib/host-lookup.svelte";
  import { messageFor } from "./lib/setup-rpc";

  const mode = $derived(serversStore.addServerMode);
  const approval = approvalRequestStore;
  /** The bridge of an approval request: it runs while the request waits. */
  const APPROVAL_PHASES = { idle: "found", waiting: "pairing", added: "paired", failed: "error", unavailable: "error" } as const;
  let serverUrl = $state("");
  let pairCode = $state("");
  let label = $state("");
  let busy = $state(false);
  let paired = $state<KnownHost | null>(null);
  let failedUrl = $state<string | null>(null);
  let approveTrigger: HTMLButtonElement | null = $state(null);
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
  /** The address field takes an address or a whole pairing link; a link carries its own token. */
  const pastedLink = $derived(parsePairLink(serverUrl));
  const targetUrl = $derived(pastedLink?.url ?? normalizeServerUrl(serverUrl));
  /** The tab the opener chose shows alone, until Other ways shows the rest. */
  const focusedTab = $derived(serversStore.addServerFocusedTab);
  const hostLookup = useHostLookup(() => targetUrl);
  const lookedUpHost = $derived(hostLookup.host);
  const sshTarget = $derived(addOverSshStore.sshTarget.trim());
  const bridgeHost = $derived<BridgeMachine | null>(
    mode === "ssh"
      ? sshTarget ? { name: sshTarget } : null
      : mode === "wsl"
        ? { name: wslHostLabel(addWslDistroStore.distro), os: "linux" }
        : mode === "approve" && approval.machine
          ? { name: approval.machine.name, os: approval.machine.os }
        : paired ? { name: paired.label, os: paired.os } : lookedUpHost,
  );
  const phase = $derived(
    mode === "ssh"
      ? sshBridgePhase(addOverSshStore)
      : mode === "wsl"
        ? wslBridgePhase(addWslDistroStore.phase)
        : mode === "approve"
          ? APPROVAL_PHASES[approval.phase]
          : pairingPhase({ targetUrl, host: lookedUpHost, isPairing: busy, isPaired: !!paired, failedUrl }),
  );
  /** The SSH form, the WSL add, and the approval request draw their own controls. */
  const isMachineAdd = $derived(mode === "ssh" || mode === "wsl" || mode === "approve");

  // An address to pair again fills the field once, as the dialog opens.
  $effect(() => {
    if (serversStore.addServerOpen) untrack(() => (serverUrl ||= serversStore.addServerUrl));
  });

  // The open tab takes the focus, so typing and Escape reach the dialog and not
  // the composer behind it: the address field, or the Approve tab itself, which
  // has nothing to type. The SSH and WSL forms focus their own fields.
  $effect(() => {
    if (!serversStore.addServerOpen || paired) return;
    const target = mode === "address" ? urlInput : mode === "approve" ? approveTrigger : null;
    if (target || !isMachineAdd) void tick().then(() => (target ?? dialog)?.focus());
  });

  function reset() {
    serverUrl = "";
    pairCode = "";
    label = "";
    paired = null;
    failedUrl = null;
    busy = false;
  }

  function close() {
    if (paired && dialog) landInHostList(dialog, paired.id);
    // A request that still waits ends with the dialog: nobody is left to read its code.
    approvalRequestStore.clear();
    reset();
    addOverSshStore.releaseDraft();
    serversStore.closeAddServer();
  }

  function selectMode(next: AddHostMode) {
    if (next === "ssh") addOverSshStore.ensureDraft();
    // The approval request and a code are two ways to one pairing: only one runs.
    if (next !== "approve") approvalRequestStore.stop();
    if (next === "address" && approvalRequestStore.url && !serverUrl) serverUrl = approvalRequestStore.url;
    serversStore.addServerMode = next;
    // A focused dialog stays focused on the way the person moved to.
    if (focusedTab) serversStore.addServerFocusedTab = next;
  }

  async function submitAddress() {
    if (pastedLink) return pair(pastedLink.url, pastedLink.pairToken);
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const code = pairCode.trim();
    // An empty code is a request to join as a device the host already trusts
    // (its local network, when the host allows it); the host answers if not.
    if (!normalizedUrl || (code && !/^\d{6}$/.test(code))) {
      toasts.error("Enter a server address and 6-digit pairing code, or paste a pairing link.");
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
        // A machine found on Tailscale keeps its Tailscale route when it pairs with a code too.
        onTailnet: approvalRequestStore.machine?.source === "tailnet" && normalizeServerUrl(url) === approvalRequestStore.url,
      });
      await serversStore.savePairedServer(result.server);
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
    const isAdding = (mode === "ssh" && addOverSshStore.phase === "running") || (mode === "wsl" && addWslDistroStore.phase === "running") || (mode === "approve" && approval.phase === "waiting");
    if (event.target === event.currentTarget && !isAdding) close();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => serversStore.addServerOpen });
</script>

{#if serversStore.addServerOpen}
  <div
    class="text-sm fixed inset-0 z-[10025] flex items-start justify-center px-4 pt-[10vh] pointer-events-auto modal-backdrop"
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
            {:else if mode === "approve" && approval.machine}
              {approval.machine.name} at <span class="font-mono">{approval.machine.detail}</span>, found on {approval.machine.source === "tailnet" ? "Tailscale" : "the local network"}.
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
        <div class="space-y-3 px-4 pt-3 pb-4">
          <SyncSettingsCheckbox />
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
            <!-- A dialog opened on one tab shows that tab alone; Other ways shows the rest. The active tab's underline alone marks it, with no line across the dialog. -->
            <div class="relative mb-4">
              <Tabs.List variant="line" class="h-auto w-full justify-start gap-4 p-0 group-data-horizontal/tabs:h-auto">
                {#if approval.machine && (!focusedTab || focusedTab === "approve")}
                  <Tabs.Trigger bind:ref={approveTrigger} value="approve" class="flex-none px-0 pb-2 after:bg-(color:--solus-accent) group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]">Approve</Tabs.Trigger>
                {/if}
                {#if !focusedTab || focusedTab === "address"}
                  <Tabs.Trigger value="address" class="flex-none px-0 pb-2 after:bg-(color:--solus-accent) group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]">Address</Tabs.Trigger>
                {/if}
                {#if !focusedTab || focusedTab === "ssh"}
                  <Tabs.Trigger value="ssh" class="flex-none px-0 pb-2 after:bg-(color:--solus-accent) group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]">SSH</Tabs.Trigger>
                {/if}
              </Tabs.List>
              {#if focusedTab}
                <button type="button" class="absolute top-0 right-0 rounded-md px-1.5 py-0.5 leading-5 text-xs text-(--solus-text-tertiary) transition-colors hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-input-focus-ring)" onclick={() => (serversStore.addServerFocusedTab = null)}>Other ways</button>
              {/if}
            </div>

            {#if mode === "approve" && approval.machine}
              <Tabs.Content value="approve" class="mt-0 space-y-3">
                {@render approveRequest(approval.machine)}
              </Tabs.Content>
            {:else if mode === "ssh"}
              <Tabs.Content value="ssh" class="mt-0 space-y-3">
                <SyncSettingsCheckbox />
                <AddOverSshForm onclose={close} />
              </Tabs.Content>
            {:else}
            <form class="space-y-3" onsubmit={(event) => { event.preventDefault(); void submitAddress(); }}>
              <!-- One row in a wide dialog: the address, its code, then its name. A pasted pairing link carries its code. -->
              <Tabs.Content value="address" class="mt-0 grid gap-3 {pastedLink ? "@min-[36rem]/add-host:grid-cols-[1fr_12rem]" : "@min-[36rem]/add-host:grid-cols-[1fr_7rem_12rem]"}">
                <label class="block min-w-0">
                  <span class="text-xs font-medium text-(--solus-text-secondary)">Address or pairing link</span>
                  <Input bind:ref={urlInput} bind:value={serverUrl} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="192.168.1.42:3000" autocomplete="off" />
                </label>
                {#if !pastedLink}
                  <label class="block">
                    <span class="text-xs font-medium text-(--solus-text-secondary)">Pair code</span>
                    <Input bind:value={pairCode} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="000000" inputmode="numeric" maxlength={6} autocomplete="one-time-code" />
                  </label>
                {/if}
                <label class="block">
                  <span class="text-xs font-medium text-(--solus-text-secondary)">Name</span>
                  <Input bind:value={label} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2  text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder={lookedUpHost?.name ?? "Optional"} autocomplete="off" />
                </label>
              </Tabs.Content>

            <SyncSettingsCheckbox />

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

<!--
  The Approve tab: the code to compare on the other machine and what to do there.
  The bridge above says how the request stands. As in the Code tab, Sync settings
  comes after the content, and the buttons have their own row.
-->
{#snippet approveRequest(machine: NonNullable<typeof approval.machine>)}
  {#if approval.phase === "added"}
    <p class="text-(--solus-text-secondary)">{machine.name} is added. You can start sessions there.</p>
    <div class="flex justify-end pt-1"><Button size="sm" onclick={close}>Done</Button></div>
  {:else}
    {#if approval.phase === "waiting"}
      <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
        <!-- The code is what the person compares on the other machine: large, and never cut. -->
        <code aria-label="Check code {approval.checkCode ?? ''}" class="shrink-0 rounded-lg border border-(--solus-popover-border) px-3 py-2 font-mono text-[1.375rem] leading-none font-medium tracking-[0.08em] text-(--solus-text-primary) tabular-nums">{approval.checkCode ?? "…"}</code>
        <div class="min-w-0 flex-1 basis-56 space-y-0.5 text-pretty">
          <p class="text-(--solus-text-primary)">On {machine.name}, approve the request if it shows this code.</p>
          <p class="text-xs text-(--solus-text-tertiary)">It shows as a notice in Solus there.</p>
        </div>
      </div>
    {:else if approval.phase === "unavailable"}
      <!-- Asking again cannot work: the machine has no approval requests. Its code can. -->
      {@render reason(`${machine.name} runs an older Solus`, `It does not take approval requests. On ${machine.name}, open Settings › Hosts › This device › Access for a pairing code, or update Solus there.`)}
    {:else if approval.phase === "failed"}
      {@render reason(`Couldn't pair with ${machine.name}`, approval.message ?? "")}
    {:else}
      <p role="status" class="text-pretty text-(--solus-text-secondary)">The request stopped.</p>
    {/if}
    <SyncSettingsCheckbox />
    <div class="flex justify-end gap-2 pt-1">
      <Button variant={approval.phase === "unavailable" ? "default" : "ghost"} size="sm" onclick={() => selectMode("address")}>Use a pairing code</Button>
      {#if approval.phase === "waiting"}
        <Button variant="outline" size="sm" onclick={() => approval.stop()}>Stop</Button>
      {:else if approval.phase !== "unavailable"}
        <!-- A machine with no approval requests gets no Ask again: it cannot answer one. -->
        <Button size="sm" onclick={() => void approval.start(machine)}>Ask again</Button>
      {/if}
    </div>
  {/if}
{/snippet}

<!-- Why a request ended without a pairing: a box the eye finds at once, with the reason in body text. -->
{#snippet reason(title: string, detail: string)}
  <div role="alert" class="flex gap-2.5 rounded-lg bg-(--solus-status-error-bg) px-3 py-2.5">
    <CircleAlert size={16} class="mt-0.5 shrink-0 text-(--solus-status-error)" />
    <div class="min-w-0 space-y-0.5 text-pretty">
      <p class="font-medium text-(--solus-text-primary)">{title}</p>
      {#if detail}<p class="text-(--solus-text-secondary)">{detail}</p>{/if}
    </div>
  </div>
{/snippet}
