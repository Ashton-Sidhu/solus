<script lang="ts">
  import { normalizeServerUrl, parsePairLink } from "@solus/client-core/pairing";
  import { connectionsNav } from "../connections/connections-nav.svelte";
  import { messageFor } from "../servers/lib/setup-rpc";
  import { Button } from "../ui/button";
  import HostStateIcon from "./HostStateIcon.svelte";
  import { pairWithCode } from "./add-machine";

  /** "Pair with a code" (D8): an address and the 6-digit code the host shows, or
   *  its pair link, which carries both. */
  let address = $state("");
  let code = $state("");
  let phase = $state<"idle" | "pairing">("idle");
  let error = $state<string | null>(null);
  let pairedLabel = $state<string | null>(null);

  const pairLink = $derived(parsePairLink(address.trim()));
  const url = $derived(pairLink?.url ?? normalizeServerUrl(address));
  const isReady = $derived(!!url && (!!pairLink || code.length === 6));

  async function pair() {
    if (!isReady || phase === "pairing") return;
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
</script>

{#if pairedLabel}
  <p class="flex items-center gap-2 text-[0.8125rem]">
    <HostStateIcon state="online" size={14} />{pairedLabel} is paired and on your map.
    <Button variant="ghost" size="sm" onclick={() => connectionsNav.back()}>See the map</Button>
  </p>
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
      <Button type="submit" size="sm" disabled={!isReady || phase === "pairing"}>{phase === "pairing" ? "Pairing…" : "Pair"}</Button>
    </div>
    {#if error}<p class="text-chrome-dense text-(--solus-status-error)" role="alert">{error}</p>{/if}
    <p class="text-chrome-dense text-muted-foreground">
      On the other machine, open Settings › Hosts › This device › Access and make a code. A pair link fills in both fields.
    </p>
  </form>
{/if}
