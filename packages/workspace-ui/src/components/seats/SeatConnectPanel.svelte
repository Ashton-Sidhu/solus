<script lang="ts">
  /**
   * One provider seat on one host: its state, the relayed login while it waits
   * on the browser, and the pasted-credential fallback. The settings row and the
   * conversation card both mount this, so a member sees one flow everywhere.
   */
  import type { SeatProvider } from "@solus/contracts/seats";
  import { seatsStore } from "../../contexts/seats/seats.store.svelte";
  import DevicePrompt from "../servers/DevicePrompt.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { seatAction, seatLabel, seatTokenHint, seatVerificationWhy } from "./lib/seat-copy";

  interface Props {
    serverId: string;
    provider: SeatProvider;
    /** The card focuses its field; a settings row does not steal focus. */
    autofocus?: boolean;
  }

  let { serverId, provider, autofocus = false }: Props = $props();

  const label = $derived(seatLabel(provider));
  const status = $derived(seatsStore.statusFor(serverId, provider));
  const verification = $derived(seatsStore.verificationFor(serverId, provider));
  const busy = $derived(seatsStore.isBusy(serverId, provider));
  const action = $derived(seatAction(status));

  let showToken = $state(false);
  let token = $state("");

  async function submitToken(event: SubmitEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    await seatsStore.connectToken(serverId, provider, token);
    token = "";
    showToken = false;
  }
</script>

<div class="flex flex-col gap-2">
  {#if status?.state === "connecting" && verification}
    <DevicePrompt
      url={verification.verificationUrl}
      code={verification.userCode}
      {label}
      requiresCodeInput={verification.requiresCodeInput}
      why={seatVerificationWhy(provider, verification.requiresCodeInput)}
      onsubmit={(code) => seatsStore.submitCode(serverId, provider, code)}
      oncancel={() => void seatsStore.cancel(serverId, provider)}
    />
  {:else if action !== "disconnect"}
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={action === "switch" ? "outline" : "default"} disabled={busy} onclick={() => void seatsStore.connect(serverId, provider)}>
        {busy ? "Starting…" : action === "switch" ? "Switch account" : action === "reconnect" ? `Reconnect ${label}` : `Connect ${label}`}
      </Button>
      <button
        type="button"
        class="text-xs text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"
        onclick={() => (showToken = !showToken)}
      >
        {showToken ? "Sign in with the browser instead" : "Paste a token instead"}
      </button>
    </div>
    {#if showToken}
      <form class="flex flex-col gap-2" onsubmit={submitToken}>
        <p class="text-xs text-pretty text-(--solus-text-tertiary)">{seatTokenHint(provider)}</p>
        <div class="flex items-center gap-2">
          <Input
            bind:value={token}
            class="h-8 min-w-0 flex-1 font-mono"
            placeholder={provider === "claude-code" ? "sk-ant-oat01-…" : "{ \"tokens\": … }"}
            aria-label="{label} credential"
            dictation={false}
            disabled={busy}
            {autofocus}
          />
          <Button type="submit" size="sm" disabled={!token.trim() || busy}>Save</Button>
        </div>
      </form>
    {/if}
  {/if}
</div>
