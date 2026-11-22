<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    CalendarClock as CalendarClockIcon,
    ChevronDown as ChevronDownIcon,
    MessagesSquare as MessagesSquareIcon,
  } from "@lucide/svelte";
  import type { PromptSender } from "@solus/contracts/types";
  import { getSurfaceContext } from "../../contexts";
  import { runHost } from "../../contexts/workspace/run-location";
  import { agentConversationMeta } from "./agent-conversation/agent-conversation-meta.store.svelte";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import { promptSenderLabel, promptSummary } from "./lib/user-message";

  /**
   * A prompt another agent or an automation sent, folded to one line: the
   * sender, the prompt's first line, and a chevron. The person's own prompts
   * stay easy to find among a coordinator's many messages. Open, it shows the
   * whole prompt and the way to its sender (docs/plans/prompt-sender.md).
   */
  interface Props {
    sender: PromptSender;
    /** Names the open state, so it survives a tab switch. */
    messageId: string;
    text: string;
    /** The conversation this prompt belongs to: its host holds the sender. */
    tabId?: string;
    body: Snippet;
  }
  let { sender, messageId, text, tabId, body }: Props = $props();

  const session = getSurfaceContext().workspace;
  const view = $derived(getTranscriptDisclosure().forKey(`sender:${messageId}`));
  const serverId = $derived(session && tabId ? runHost(session.sessionFor(tabId)?.run) : undefined);

  // The sender session's name as it reads now; it runs on this session's host.
  // An automation keeps the name it had when it sent.
  $effect(() => {
    if (sender.kind !== "agent" || !session || !tabId) return;
    return agentConversationMeta.retain(sender.sessionId, session.apiFor(tabId), serverId);
  });
  const agentMeta = $derived(sender.kind === "agent" ? agentConversationMeta.metaFor(sender.sessionId) : undefined);
  const label = $derived(promptSenderLabel(sender, agentMeta?.customTitle || agentMeta?.slug || undefined));
  const summary = $derived(promptSummary(text));

  async function openSender(): Promise<void> {
    if (!session) return;
    if (sender.kind === "automation") {
      session.openAutomations(sender.automationId);
      return;
    }
    if (!serverId || !(await session.revealSession(sender.sessionId, serverId))) {
      session.notifySessionUnavailable(sender.provider);
    }
  }
</script>

<!-- The fold is the bubble's own first row, so open or shut it is one shape. -->
<button
  type="button"
  aria-expanded={view.expanded}
  aria-label="{label}: {summary}"
  onclick={() => (view.expanded = !view.expanded)}
  class="flex w-full min-w-0 cursor-pointer items-center overflow-hidden gap-1.5 rounded-2xl px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:min-h-11"
>
  {#if sender.kind === "agent"}
    <MessagesSquareIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
  {:else}
    <CalendarClockIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
  {/if}
  <span class="max-w-1/2 shrink-0 truncate text-(--solus-text-tertiary)">{label}</span>
  <span class="min-w-0 flex-1 truncate text-(--solus-text-primary)">{summary}</span>
  <ChevronDownIcon
    size={14}
    class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 motion-reduce:transition-none {view.expanded ? 'rotate-180' : ''}"
    aria-hidden="true"
  />
</button>
{#if view.expanded}
  <div class="px-3 pb-2.5">
    {@render body()}
    {#if session}
      <div class="mt-1.5 flex justify-end">
        <button
          type="button"
          onclick={() => void openSender()}
          class="cursor-pointer text-xs font-medium text-(--solus-text-tertiary) transition-colors duration-100 hover:text-(--solus-text-primary) focus-visible:text-(--solus-text-primary) focus-visible:outline-none pointer-coarse:min-h-10"
        >
          {sender.kind === "agent" ? "Open session" : "Open automation"}
        </button>
      </div>
    {/if}
  </div>
{/if}
