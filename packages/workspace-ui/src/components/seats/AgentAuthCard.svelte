<script lang="ts">
  /**
   * A Claude Design or MCP server sign-in the person asked for with a command
   * (docs/plans/agent-auth-commands.md). It takes the attention shell at the tail
   * of the transcript, like the seat card, and offers the same browser prompt.
   */
  import { KeyRound as KeyIcon, X as XIcon } from "@lucide/svelte";
  import { agentAuthStore } from "../../contexts/seats/agent-auth.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import AttentionCard from "../conversation/AttentionCard.svelte";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import DevicePrompt from "../servers/DevicePrompt.svelte";

  const flow = $derived(agentAuthStore.flow);
  const finished = $derived(flow?.phase === "done" || flow?.phase === "external");

  let cardEl = $state<HTMLDivElement | null>(null);

  function close() {
    void agentAuthStore.cancel();
    requestInputFocus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (!(event.target instanceof Node) || !cardEl?.contains(event.target)) return;
    event.preventDefault();
    close();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if flow}
  <div bind:this={cardEl}>
    <AttentionCard
      title={flow.phase === "done" ? `Signed in to ${flow.title}` : `Sign in to ${flow.title}`}
      type={finished ? (flow.message ?? "done") : "on the host"}
      resolved={flow.phase === "done"}
      testId="agent-auth-card"
    >
      {#snippet icon()}
        <span class="inline-flex size-5 items-center justify-center rounded-md bg-card shadow-[shadow:var(--solus-tx-hairline)]">
          <KeyIcon size={13} />
        </span>
      {/snippet}

      {#snippet actions()}
        {#if flow.phase === "done"}
          <TranscriptCardAction onclick={close}>Done</TranscriptCardAction>
        {:else}
          <TranscriptCardAction kind="icon" label="Close" onclick={close}>
            <XIcon size={13} />
          </TranscriptCardAction>
        {/if}
      {/snippet}

      {#if flow.phase === "starting"}
        <p class="m-0 text-(--muted-foreground)" role="status">Starting the sign-in on the host…</p>
      {:else if flow.phase === "failed"}
        <p class="m-0 text-pretty text-destructive" role="alert">{flow.message}</p>
        <div>
          <TranscriptCardAction kind="ghost" class="-ml-2.5" onclick={close}>Close</TranscriptCardAction>
        </div>
      {:else if flow.phase === "external" && flow.url}
        <p class="m-0 text-pretty text-(--muted-foreground)">{flow.message}</p>
        <DevicePrompt url={flow.url} why="Approve the connector in your browser." />
      {:else if flow.phase === "waiting" && flow.url}
        <DevicePrompt
          url={flow.url}
          requiresCodeInput
          label={flow.title}
          why={flow.input === "code"
            ? `Finish signing in to ${flow.title} in your browser, then paste the code here.`
            : "Finish signing in in your browser. If the page then fails to load, copy its address and paste it here."}
          onsubmit={(value) => agentAuthStore.submit(value)}
          oncancel={close}
        />
      {/if}
    </AttentionCard>
  </div>
{/if}
