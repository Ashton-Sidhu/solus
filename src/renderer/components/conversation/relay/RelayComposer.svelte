<script lang="ts">
  import { ArrowUpIcon } from "phosphor-svelte";

  /**
   * Inline reply into the peer session, without leaving the thread. The reply
   * becomes a user turn in the PEER's transcript (queued behind its active turn
   * when busy); the peer's answer is read by opening the session — arming a
   * relay exchange is the orchestrating agent's move, not the composer's.
   */
  interface Props {
    peerSessionId: string;
    agentName: string;
    busy: boolean;
  }
  let { peerSessionId, agentName, busy }: Props = $props();

  let draft = $state("");
  let sending = $state(false);
  let sentNotice = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let composing = $state(false);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    try {
      const result = await window.solus.promptSession(peerSessionId, text, "queue");
      draft = "";
      sentNotice = result.disposition === "queued" ? "queued" : "sent";
      setTimeout(() => (sentNotice = null), 2500);
      inputEl?.focus();
    } catch {
      sentNotice = "failed to send";
      setTimeout(() => (sentNotice = null), 2500);
    } finally {
      sending = false;
    }
  }
</script>

{#if composing}
  <div class="flex items-center gap-2 flex-1 min-w-0">
    <input
      bind:this={inputEl}
      bind:value={draft}
      class="flex-1 min-w-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/60"
      placeholder="Reply to {agentName} directly…"
      onkeydown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void send();
        }
        if (e.key === "Escape") composing = false;
      }}
    />
    {#if sentNotice}
      <span class="text-[11px] text-muted-foreground/60 shrink-0">{sentNotice}</span>
    {:else if busy}
      <span class="font-mono text-[10.5px] text-muted-foreground/50 shrink-0">queues behind its turn</span>
    {/if}
    <button
      class="flex items-center justify-center size-6 rounded-md shrink-0 cursor-pointer bg-primary text-primary-foreground hover:brightness-105 disabled:opacity-40"
      disabled={!draft.trim() || sending}
      onclick={send}
      aria-label="Send reply to {agentName}"
    >
      <ArrowUpIcon size={12} />
    </button>
  </div>
{:else}
  <button
    class="text-[12px] text-muted-foreground cursor-pointer hover:text-foreground"
    onclick={() => {
      composing = true;
      setTimeout(() => inputEl?.focus());
    }}
  >
    Reply to {agentName}
  </button>
{/if}
