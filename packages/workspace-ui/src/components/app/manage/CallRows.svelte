<script lang="ts">
  import { ChevronRight as OpenIcon } from "@lucide/svelte";
  import type { AppCallView, AppWebhookView } from "@solus/contracts/apps";
  import CallDetail from "./CallDetail.svelte";
  import { appTime, callOutcomeLabel, callerText } from "../lib/app-view";
  import { callDurationText } from "./lib/activity";

  /** Rows of the call log. A row opens the call's detail under it; one call is open at a time. */
  interface Props {
    serverId: string;
    appId: string;
    calls: AppCallView[];
    /** The webhooks of the app: a webhook caller goes by its declared name. */
    webhooks: AppWebhookView[];
    openCallId: string | null;
    onOpenRun?: (runId: string) => void;
  }
  let { serverId, appId, calls, webhooks, openCallId = $bindable(), onOpenRun }: Props = $props();
</script>

<ul class="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border/50 p-0" data-testid="app-calls">
  {#each calls as call (call.id)}
    {@const isOpen = openCallId === call.id}
    <li class="flex min-w-0 flex-col border-b border-border/40 last:border-b-0">
      <button
        type="button"
        class="flex min-h-9 w-full min-w-0 cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 overflow-hidden border-0 bg-transparent px-3 py-2 text-left text-xs transition-colors duration-150 hover:bg-[var(--wash-1)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none pointer-coarse:min-h-11"
        aria-expanded={isOpen}
        data-testid="app-call-row"
        onclick={() => (openCallId = isOpen ? null : call.id)}
      >
        <OpenIcon size={12} class="shrink-0 self-center text-muted-foreground transition-transform duration-150 {isOpen ? 'rotate-90' : ''}" aria-hidden="true" />
        <code class="min-w-0 shrink truncate font-mono text-(--solus-text-primary)">{call.operation}</code>
        <span class="min-w-0 flex-1 truncate text-muted-foreground">{callerText(call.caller, webhooks)}</span>
        <span class="shrink-0 {call.outcome === 'failed' ? 'text-destructive' : 'text-muted-foreground'}">{callOutcomeLabel(call.outcome)}</span>
        <span class="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{callDurationText(call)}</span>
        <span class="w-20 shrink-0 truncate text-right tabular-nums text-muted-foreground" title={new Date(call.startedAt).toLocaleString()}>{appTime(call.startedAt)}</span>
      </button>
      {#if call.error && !isOpen}
        <p class="m-0 truncate px-3 pb-2 pl-8 text-xs text-destructive" title={call.error}>{call.error}</p>
      {/if}
      {#if isOpen}
        <CallDetail {serverId} {appId} callId={call.id} {onOpenRun} />
      {/if}
    </li>
  {/each}
</ul>
