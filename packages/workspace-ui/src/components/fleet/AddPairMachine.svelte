<script lang="ts">
  import { normalizeServerUrl, parsePairLink, urlHost } from "@solus/client-core/pairing";
  import { PAIR_APPROVAL_TTL_MS } from "@solus/contracts/add-machine";
  import { onDestroy } from "svelte";
  import { newCheckCode } from "../../lib/check-code";
  import { countdown } from "../../lib/countdown";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { messageFor } from "../servers/lib/setup-rpc";
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { pairWithApproval, pairWithCode } from "./add-machine";

  /** "Pair with a code": an address and the 6-digit code the host shows, or
   *  its pair link, which carries both. With only an address, "Ask it to approve"
   *  sends an approval request instead: the host's owner approves it after they
   *  compare the check code (docs/plans/add-machine-card.md). */
  let address = $state("");
  let code = $state("");
  let phase = $state<"idle" | "pairing" | "approving">("idle");
  let error = $state<string | null>(null);
  let pairedLabel = $state<string | null>(null);
  let approval = $state<{ checkCode: string; expiresAt: number } | null>(null);
  let stopApproval: AbortController | null = null;

  const pairLink = $derived(parsePairLink(address.trim()));
  const url = $derived(pairLink?.url ?? normalizeServerUrl(address));
  const isReady = $derived(!!url && (!!pairLink || code.length === 6));
  const canAskApproval = $derived(!!url && !pairLink && phase === "idle");

  let now = $state(Date.now());
  $effect(() => {
    if (!approval) return;
    now = Date.now();
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  async function pair() {
    if (!isReady || phase !== "idle") return;
    phase = "pairing";
    error = null;
    try {
      const server = await pairWithCode(url, pairLink?.pairToken ?? code);
      pairedLabel = server.label;
    } catch (err) {
      error = messageFor(err);
    } finally {
      phase = "idle";
    }
  }

  async function askApproval() {
    if (!canAskApproval) return;
    phase = "approving";
    error = null;
    const checkCode = newCheckCode();
    // The check code shows before the request goes, so the person can compare it on the other machine.
    approval = { checkCode, expiresAt: Date.now() + PAIR_APPROVAL_TTL_MS };
    const controller = new AbortController();
    stopApproval = controller;
    try {
      const server = await pairWithApproval(url, checkCode, ({ expiresAt }) => { if (approval) approval.expiresAt = expiresAt; }, controller.signal);
      pairedLabel = server.label;
    } catch (err) {
      if (!controller.signal.aborted) error = messageFor(err);
    } finally {
      stopApproval = null;
      approval = null;
      phase = "idle";
    }
  }

  // Leaving the page stops a request that still waits.
  onDestroy(() => stopApproval?.abort());
</script>

{#if pairedLabel}
  <p class="flex items-center gap-2 text-[0.8125rem]">
    <HostStateIcon state="online" size={14} />{pairedLabel} is paired and on your map.
    <Button variant="ghost" size="sm" onclick={() => connectionsNav.back()}>See the map</Button>
  </p>
{:else if approval}
  <div class="flex flex-col items-start gap-2" role="status" aria-live="polite">
    <span class="text-[0.8125rem] text-(--solus-text-secondary)">Waiting for {urlHost(url)} · {countdown(approval.expiresAt - now)}</span>
    <code class="font-mono text-[1.75rem] leading-none font-medium tracking-[0.08em] text-(--solus-text-primary) tabular-nums">{approval.checkCode}</code>
    <p class="text-chrome-dense text-muted-foreground">
      Approve it in Solus on {urlHost(url)}, or run <code class="font-mono">solus host approve {approval.checkCode}</code> there. Approve only if it shows this code.
    </p>
    <Button variant="ghost" size="sm" onclick={() => stopApproval?.abort()}>Stop asking</Button>
  </div>
{:else}
  <form class="flex flex-col gap-3" onsubmit={(event) => { event.preventDefault(); void pair(); }}>
    <div class="flex flex-wrap items-end gap-3">
      <label class="flex min-w-0 flex-1 basis-56 flex-col gap-1.5">
        <span class="text-[0.8125rem] text-(--solus-text-secondary)">Address or pair link</span>
        <input
          name="pair-address"
          bind:value={address}
          {@attach (element) => element.focus()}
          placeholder="192.168.1.42:4317, or paste a pair link"
          class="h-8 rounded-lg border border-border/60 bg-background px-2.5 font-mono text-[0.8125rem] outline-none placeholder:font-sans placeholder:text-muted-foreground focus:border-(--solus-status-running)/50 max-sm:text-base"
        />
      </label>
      {#if !pairLink}
        <label class="flex flex-col gap-1.5">
          <span class="text-[0.8125rem] text-(--solus-text-secondary)">Code</span>
          <input
            name="pair-code"
            bind:value={code}
            oninput={() => (code = code.replace(/\D/g, "").slice(0, 6))}
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            class="h-8 w-[7.5rem] rounded-lg border border-border/60 bg-background px-2.5 font-mono text-[0.9375rem] tracking-[0.35em] tabular-nums outline-none placeholder:text-muted-foreground/50 focus:border-(--solus-status-running)/50 max-sm:text-base"
          />
        </label>
      {/if}
      <Button type="submit" size="sm" disabled={!isReady || phase !== "idle"}>{phase === "pairing" ? "Pairing…" : "Pair"}</Button>
      {#if canAskApproval}
        <Button type="button" variant="outline" size="sm" onclick={() => void askApproval()}>Ask it to approve</Button>
      {/if}
    </div>
    {#if error}<p class="text-chrome-dense text-(--solus-status-error)" role="alert">{error}</p>{/if}
    <p class="text-chrome-dense text-muted-foreground">
      On the other machine, open Settings › Hosts › This device › Access and make a code. A pair link fills in both fields. With no code, ask it to approve this device.
    </p>
  </form>
{/if}
