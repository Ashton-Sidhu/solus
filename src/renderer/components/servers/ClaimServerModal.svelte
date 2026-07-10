<script lang="ts">
  import { tick } from "svelte";
  import { CheckCircleIcon, KeyIcon, XIcon } from "phosphor-svelte";
  import { claimServer, desktopDeviceLabel, type ClaimServerResult } from "@client-core/pairing";
  import { discoveredServerUrl } from "./discovery";
  import { serversStore } from "./servers.store.svelte";

  let code = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);
  let claimed = $state<ClaimServerResult | null>(null);
  let codeInput: HTMLInputElement | null = $state(null);

  const target = $derived(serversStore.claimTarget);
  const serverUrl = $derived(target ? discoveredServerUrl(target) : "");

  $effect(() => {
    if (!serversStore.claimServerOpen) return;
    void tick().then(() => codeInput?.focus());
  });

  function reset() {
    code = "";
    error = null;
    busy = false;
    claimed = null;
  }

  function close() {
    reset();
    serversStore.closeClaimServer();
  }

  async function submit() {
    if (!target) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) {
      error = "Enter the 6-digit claim code from the server terminal.";
      return;
    }

    busy = true;
    error = null;
    try {
      const result = await claimServer({
        url: serverUrl,
        code: trimmed,
        deviceLabel: desktopDeviceLabel(),
        serverLabel: target.name,
      });
      serversStore.savePairedServer(result.server);
      serversStore.dismissedDiscovered.add(target.installationId);
      claimed = result;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  function switchNow() {
    if (!claimed) return;
    serversStore.claimServerOpen = false;
    serversStore.switchTo(claimed.server.id);
  }

  function handleBackdrop(event: MouseEvent) {
    if (event.target === event.currentTarget) close();
  }
</script>

{#if serversStore.claimServerOpen && target}
  <div
    class="fixed inset-0 z-[10025] flex items-start justify-center bg-black/[0.05] px-4 pt-[10vh] pointer-events-auto [.dark_&]:bg-black/35"
    role="presentation"
    onclick={handleBackdrop}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="claim-server-title"
      class="w-full max-w-[28rem] overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-(--solus-popover-shadow) backdrop-blur-xl"
    >
      <header class="flex items-center justify-between gap-3 border-b border-(--solus-popover-border) px-4 py-3">
        <div class="min-w-0">
          <h2 id="claim-server-title" class="truncate text-[0.9375rem] font-semibold text-(--solus-text-primary)">Claim server</h2>
          <p class="mt-0.5 truncate text-[0.75rem] text-(--solus-text-tertiary)">{target.name} · {target.host}:{target.port}</p>
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

      {#if claimed}
        <div class="space-y-4 px-4 py-4">
          <div class="flex items-start gap-3 rounded-xl bg-(--solus-accent-light) p-3 text-(--solus-text-primary)">
            <CheckCircleIcon size={18} class="mt-0.5 shrink-0 text-(--solus-status-complete)" />
            <div class="min-w-0">
              <div class="text-[0.8125rem] font-medium">Server claimed</div>
              <div class="mt-1 text-[0.75rem] text-(--solus-text-tertiary)">Verify this fingerprint matches the server terminal.</div>
              <div class="mt-2 inline-flex rounded-lg bg-(--solus-input-bg) px-2 py-1 font-mono text-[0.8125rem] tracking-[0.08em] text-(--solus-text-primary)">
                {claimed.fingerprint}
              </div>
            </div>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" class="rounded-lg px-3 py-2 text-[0.8125rem] text-(--solus-text-secondary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" onclick={close}>Done</button>
            <button type="button" class="rounded-lg bg-(--solus-accent) px-3 py-2 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-transform active:scale-[0.96]" onclick={switchNow}>Switch now</button>
          </div>
        </div>
      {:else}
        <form class="space-y-4 px-4 py-4" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div class="rounded-xl bg-(--solus-surface-hover) px-3 py-2 text-[0.75rem] text-(--solus-text-secondary)">
            Enter the claim code printed in the server terminal. After claiming, compare the fingerprint before switching.
          </div>

          <label class="block">
            <span class="text-[0.75rem] font-medium text-(--solus-text-secondary)">Claim code</span>
            <input bind:this={codeInput} bind:value={code} class="mt-1 w-full rounded-lg border border-(--solus-input-border) bg-(--solus-input-bg) px-3 py-2 font-mono text-[0.8125rem] tracking-[0.16em] text-(--solus-text-primary) outline-none transition-[border-color,box-shadow] placeholder:text-(--solus-text-quaternary) focus:border-(--solus-input-focus-border) focus:shadow-[0_0_0_3px_var(--solus-input-focus-ring)]" placeholder="000000" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />
          </label>

          {#if error}
            <div class="rounded-lg bg-(--solus-status-error-bg) px-3 py-2 text-[0.75rem] text-(--solus-status-error)">{error}</div>
          {/if}

          <div class="flex justify-end gap-2 pt-1">
            <button type="button" class="rounded-lg px-3 py-2 text-[0.8125rem] text-(--solus-text-secondary) transition-[background-color,color,transform] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" onclick={close}>Cancel</button>
            <button type="submit" disabled={busy} class="inline-flex items-center gap-2 rounded-lg bg-(--solus-accent) px-3 py-2 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-[opacity,transform] active:scale-[0.96] disabled:cursor-wait disabled:opacity-60">
              <KeyIcon size={14} />
              {busy ? "Claiming..." : "Claim"}
            </button>
          </div>
        </form>
      {/if}
    </div>
  </div>
{/if}
