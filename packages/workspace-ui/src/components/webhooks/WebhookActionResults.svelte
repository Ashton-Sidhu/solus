<script lang="ts">
  /** One row for each action of a delivery or a dry run: its status, its filter
   *  results, the rendered prompt, the placeholders with no value, the error,
   *  and a link to the session it started (docs/plans/webhooks.md §3.3). */
  import { Check as CheckIcon, RotateCcw as ReplayIcon, X as XIcon } from "@lucide/svelte";
  import type { WebhookActionResult } from "@solus/contracts/webhooks";
  import { Button } from "../ui/button";
  import { actionTypeLabel } from "./lib/webhooks-view";
  import { actionStatusLabel, filterText } from "./lib/webhook-deliveries";

  let {
    results,
    onOpenSession,
    onReplay,
  }: {
    results: WebhookActionResult[];
    onOpenSession?: (sessionId: string) => void;
    onReplay?: (actionId: string) => void;
  } = $props();
</script>

<ol class="flex flex-col gap-2">
  {#each results as result, index (result.actionId)}
    <li class="flex flex-col gap-1.5 rounded-lg border border-border/50 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium">Action {index + 1}</span>
        <span class="text-muted-foreground">{actionTypeLabel(result.type)}</span>
        <span class={result.status === "failed" || result.status === "busy" ? "text-destructive" : ""}>{actionStatusLabel(result.status)}</span>
        {#if result.sessionId && onOpenSession}
          {@const sessionId = result.sessionId}
          <Button size="xs" variant="link" onclick={() => onOpenSession(sessionId)}>Open session</Button>
        {/if}
        {#if onReplay}
          <Button size="xs" variant="ghost" class="ml-auto" onclick={() => onReplay(result.actionId)}>
            <ReplayIcon size={14} /> Replay this action
          </Button>
        {/if}
      </div>
      {#if result.filters.length > 0}
        <ul class="flex flex-col gap-0.5 font-mono text-xs">
          {#each result.filters as filterResult, filterIndex (filterIndex)}
            <li class="flex items-center gap-1.5 {filterResult.matched ? 'text-muted-foreground' : 'text-destructive'}">
              {#if filterResult.matched}<CheckIcon size={12} aria-label="Matched" />{:else}<XIcon size={12} aria-label="Did not match" />{/if}
              {filterText(filterResult.filter)}
            </li>
          {/each}
        </ul>
      {/if}
      {#if result.missing.length > 0}
        <p class="text-xs text-destructive">No value for: {result.missing.join(", ")}</p>
      {/if}
      {#if result.error}
        <p class="text-xs text-destructive">{result.error}</p>
      {/if}
      {#if result.prompt !== undefined}
        <pre class="max-h-60 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{result.prompt}</pre>
      {/if}
    </li>
  {/each}
</ol>
