<script lang="ts">
  import { Ban as StoppedIcon, Check as CheckIcon, CircleAlert as AlertIcon, CircleX as FailedIcon } from "@lucide/svelte";
  import type { BackgroundItem } from "@solus/client-core/background-item";
  import ActivityRow from "./ActivityRow.svelte";
  import { Button } from "../ui/button";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { conversationIsVisible } from "./lib/conversation-visibility";
  import { formatActivityDuration } from "./lib/activity-summary";

  /**
   * One item of a session's background work that the host keeps (an MCP task;
   * a resource watch later), on the row `BackgroundWorkRow` uses: the glyph,
   * what runs, its state in the target, its actions, and the time since the
   * start on the rail. It knows nothing of the kind: `item` is all it reads.
   */
  interface Props {
    item: BackgroundItem;
    /** Resolves once the host took the request; the item's next state comes as data. */
    onAction: (actionId: string) => Promise<void>;
  }
  let { item, onAction }: Props = $props();

  let busyActionId = $state<string | null>(null);

  async function act(actionId: string): Promise<void> {
    busyActionId = actionId;
    try {
      await onAction(actionId);
    } finally {
      busyActionId = null;
    }
  }

  let now = $state(Date.now());
  const onScreen = conversationIsVisible();
  $effect(() => {
    if (item.startedAt === null || !onScreen()) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });
  const elapsed = $derived(item.startedAt === null ? "" : formatActivityDuration(Math.max(0, now - item.startedAt)));
</script>

{#snippet detailText()}{item.detail}{/snippet}

{#snippet actionButtons()}
  {#if item.actions.length}
    <span class="flex shrink-0 items-center gap-1">
      {#each item.actions as action (action.id)}
        <Button
          variant="ghost"
          size="xs"
          class="h-5 px-1.5 text-muted-foreground hover:text-foreground"
          disabled={busyActionId !== null}
          onclick={() => act(action.id)}
          data-testid="background-item-{action.id}"
        >
          {busyActionId === action.id ? action.busyLabel : action.label}
        </Button>
      {/each}
    </span>
  {/if}
{/snippet}

{#snippet elapsedRail()}<span class="activity-rail-time">{elapsed}</span>{/snippet}

<ActivityRow
  target={detailText}
  proseTarget
  actions={actionButtons}
  rail={elapsed ? elapsedRail : undefined}
  glyphClass={item.state === "failed" ? "is-destructive" : ""}
  testid="background-item-row"
>
  {#snippet glyph()}
    {#if item.state === "running"}
      <span class="activity-spinner" aria-hidden="true"></span>
    {:else if item.state === "attention"}
      <AlertIcon aria-hidden="true" />
    {:else if item.state === "failed"}
      <FailedIcon aria-hidden="true" />
    {:else if item.state === "stopped"}
      <StoppedIcon aria-hidden="true" />
    {:else}
      <CheckIcon aria-hidden="true" />
    {/if}
  {/snippet}
  {#snippet label()}<span class={item.state === "running" ? "activity-shimmer" : ""}>{item.label}</span>{/snippet}
</ActivityRow>
