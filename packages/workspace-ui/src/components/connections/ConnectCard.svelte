<script lang="ts">
  /**
   * The agents of this conversation asked for external accounts mid-turn. That
   * is an interrupt like any other — something stopped and only the user can
   * restart it — so it stands at the tail of the transcript beside the
   * permission and question cards, not in a chrome banner of its own.
   *
   * One card holds every service the turn asked for, one row each, drawn like
   * the agent conversation card: the card surface, an eyebrow with the count,
   * and the rows. Each row signs in by itself; once the rows are connected the
   * card goes quiet and offers Continue.
   */
  import { Plug } from "@lucide/svelte";
  import { connectRequestStore, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";
  import { ensureIconCollections } from "../../lib/iconify";
  import { integrationsStore } from "../settings/integrations.store.svelte";
  import ConnectRequestRow from "./ConnectRequestRow.svelte";
  import { connectCardHeading, connectContinuePrompt, connectRequestCopy } from "./lib/connect-card-copy";
  import { connectRequestStatus } from "./lib/connect-request-status";
  import { connectRequestKey } from "../../contexts/connections/connect-request.store.svelte";
  import { openChatDraft } from "../../contexts/workspace/new-chat";
  import { runHost } from "../../contexts/workspace/run-location";

  interface Props {
    tabId: string;
  }

  let { tabId }: Props = $props();

  ensureIconCollections();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const serverId = $derived(runHost(sess?.run));
  const requests = $derived(sess ? connectRequestStore.requestsFor(serverId, sess.id) : []);
  const rows = $derived(requests.map((request) => ({ request, status: connectRequestStatus(request) })));
  const settled = $derived(rows.filter((row) => row.status !== "pending"));
  const isSettled = $derived(rows.length > 0 && settled.length === rows.length);
  const connectedCount = $derived(rows.filter((row) => row.status === "connected").length);
  const heading = $derived(connectCardHeading(rows.length, settled.length, rows.length === 1 && rows[0].request.kind === "custom-server"));

  let cardEl = $state<HTMLElement | null>(null);

  function close() {
    if (sess) connectRequestStore.dismiss(serverId, sess.id);
    requestInputFocus();
  }

  function dismiss() {
    // A sign-in this card started ends with it, here and on the host.
    for (const { request, status } of rows) {
      if (request.kind === "integration" && status === "pending") void integrationsStore.cancel(request.serverId, request.integrationId);
    }
    close();
  }

  /** "Set up with an agent" (§13.4): a new chat on this host whose prompt finds what to create. */
  function handOff(prompt: string) {
    if (!serverId) return;
    dismiss();
    openChatDraft(session, "click", { serverId, prompt });
  }

  // The turn is still waiting on the agent's side, so the way back in is a
  // prompt, not a silent resume.
  function continueRun() {
    const labels = settled.map(({ request }) => connectRequestCopy(request).providerLabel);
    session.dispatch.sendMessage(connectContinuePrompt(labels), undefined, tabId);
    close();
  }

  // Escape belongs to whatever owns focus. While the caret is in this card it
  // is the card's; the conversation's own Escape bindings keep it otherwise.
  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (!(event.target instanceof Node) || !cardEl?.contains(event.target)) return;
    event.preventDefault();
    dismiss();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if rows.length > 0}
  <div class="py-1 animate-msg-in-side">
    <section
      bind:this={cardEl}
      class="flex flex-col rounded-(--tx-card-radius) bg-(--solus-tx-card-bg) p-1 text-transcript-card {isSettled
        ? 'shadow-[shadow:var(--solus-tx-quiet-shadow)]'
        : 'shadow-[shadow:var(--solus-tx-attention-shadow)]'}"
      data-testid="connection-connect-card"
      data-state={isSettled ? "settled" : "pending"}
      aria-label={heading}
    >
      <div class="flex min-w-0 items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-transcript-meta text-muted-foreground">
        <Plug size={13} aria-hidden="true" class="shrink-0 opacity-80" />
        <span class="min-w-0 truncate">{heading}</span>
        <span class="flex-1"></span>
        {#if rows.length > 1}
          <span class="shrink-0 tabular-nums">{connectedCount} of {rows.length} connected</span>
        {/if}
      </div>
      {#each rows as { request } (connectRequestKey(request))}
        <ConnectRequestRow {request} onhandoff={handOff} />
      {/each}
      <div class="flex flex-wrap items-center justify-end gap-2 px-2 pt-1 pb-1.5">
        <TranscriptCardAction kind="ghost" onclick={isSettled ? close : dismiss}>{isSettled ? "Done" : "Not now"}</TranscriptCardAction>
        {#if settled.length > 0}
          <TranscriptCardAction kind={isSettled ? "filled" : "primary"} onclick={continueRun}>Continue</TranscriptCardAction>
        {/if}
      </div>
    </section>
  </div>
{/if}
