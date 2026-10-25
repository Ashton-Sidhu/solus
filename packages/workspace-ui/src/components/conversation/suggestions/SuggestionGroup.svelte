<script lang="ts">
  import { untrack } from "svelte";
  import { Lightbulb as SuggestionIcon, Paperclip as PaperclipIcon } from "@lucide/svelte";
  import { getWorkspaceContext, suggestionsStore } from "../../../contexts";
  import { canDriveSession } from "../../../contexts/sharing/resource-roles";
  import { runHost } from "../../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { suggestionRows } from "@solus/client-core/suggestion-rows";

  interface Props {
    tabId: string;
  }
  let { tabId }: Props = $props();

  /**
   * A session's suggestions (docs/plans/custom-roles.md §7), under the queue: what a
   * guest proposed, with Send and Dismiss for whoever may prompt, and what became of
   * a guest's own. Send runs the suggestion as the reader's own turn.
   */
  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const serverId = $derived(runHost(sess?.run));
  const sessionId = $derived(sess?.id);
  const mayPrompt = $derived(canDriveSession(serverId, sessionId, "drive.prompt"));
  const rows = $derived(suggestionRows(suggestionsStore.listFor(serverId, sessionId), mayPrompt));
  let busyId = $state<string | null>(null);

  const target = () => (serverId && sessionId ? { serverId, sessionId, api: session.apiFor(tabId), ctx: session.ctxFor(tabId) } : null);

  $effect(() => {
    if (!serverId || !sessionId) return;
    untrack(() => {
      const current = target();
      if (current) suggestionsStore.ensure(current);
    });
  });

  async function act(suggestionId: string, action: "send" | "dismiss" | "withdraw"): Promise<void> {
    const current = target();
    if (!current || busyId) return;
    busyId = suggestionId;
    try {
      if (action === "withdraw") await suggestionsStore.withdraw(current, suggestionId);
      else await suggestionsStore.decide(current, suggestionId, action);
    } finally {
      busyId = null;
      requestInputFocus({ tabId });
    }
  }
</script>

{#if rows.length > 0}
  <section class="flex flex-col gap-2 pt-3 pb-1.5" aria-label="Suggestions" data-testid="session-suggestions">
    {#each rows as row (row.suggestion.id)}
      {@const suggestion = row.suggestion}
      <article
        class="flex flex-col gap-2 rounded-xl border-[0.0625rem] border-border bg-muted/30 px-3.5 py-3 {suggestion.state === 'waiting' ? '' : 'opacity-70'}"
        data-testid="session-suggestion"
        data-state={suggestion.state}
      >
        <header class="flex min-w-0 items-center gap-2 text-transcript-meta text-(--solus-text-tertiary)">
          <SuggestionIcon size={14} class="shrink-0" />
          <span class="truncate">{row.caption}</span>
        </header>
        <p class="text-pretty whitespace-pre-wrap break-words text-foreground">{suggestion.text}</p>
        {#if suggestion.attachments.length > 0}
          <ul class="flex flex-wrap gap-1.5 text-transcript-meta text-(--solus-text-tertiary)">
            {#each suggestion.attachments as attachment (attachment.hostPath)}
              <li class="flex max-w-60 min-w-0 items-center gap-1 overflow-hidden rounded-md bg-muted px-1.5 py-0.5"><PaperclipIcon size={12} class="shrink-0" /><span class="truncate">{attachment.name}</span></li>
            {/each}
          </ul>
        {/if}
        {#if row.canDecide || row.canWithdraw}
          <div class="flex items-center justify-end gap-2">
            {#if row.canWithdraw}
              <Button variant="ghost" size="sm" class="pointer-coarse:h-10" disabled={busyId !== null} onclick={() => void act(suggestion.id, "withdraw")} data-testid="suggestion-withdraw">Withdraw</Button>
            {/if}
            {#if row.canDecide}
              <Button variant="ghost" size="sm" class="pointer-coarse:h-10" disabled={busyId !== null} onclick={() => void act(suggestion.id, "dismiss")} data-testid="suggestion-dismiss">Dismiss</Button>
              <Button size="sm" class="pointer-coarse:h-10" disabled={busyId !== null} onclick={() => void act(suggestion.id, "send")} data-testid="suggestion-send">Send</Button>
            {/if}
          </div>
        {/if}
      </article>
    {/each}
  </section>
{/if}
