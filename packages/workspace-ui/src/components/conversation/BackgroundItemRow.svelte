<script lang="ts">
  import { Ban as StoppedIcon, Check as CheckIcon, CircleAlert as AlertIcon, CircleX as FailedIcon, Eye as WaitingIcon } from "@lucide/svelte";
  import type { BackgroundItem } from "@solus/client-core/background-item";
  import ActivityRow from "./ActivityRow.svelte";
  import BackgroundStopButton from "./BackgroundStopButton.svelte";
  import { Button } from "../ui/button";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { conversationIsVisible } from "./lib/conversation-visibility";
  import { formatActivityDuration } from "./lib/activity-summary";

  /**
   * One item of a session's background work that the host keeps (an MCP task
   * or a resource watch), on the row `BackgroundWorkRow` uses: the glyph,
   * what runs, its state in the target, its actions, and on the rail the time
   * since the start and the stop button. It knows nothing of the kind: `item` is all it reads.
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
  const stopAction = $derived(item.actions.find((action) => action.stops));
  const wordActions = $derived(item.actions.filter((action) => !action.stops));
</script>

{#snippet detailText()}{item.detail}{/snippet}

{#snippet actionButtons()}
  {#if wordActions.length}
    <span class="flex shrink-0 items-center gap-1">
      {#each wordActions as action (action.id)}
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

<!-- The time since the start, then Stop, last on the rail as on `BackgroundWorkRow`. -->
{#snippet railItems()}
  {#if elapsed}<span class="activity-rail-time">{elapsed}</span>{/if}
  {#if stopAction}
    <BackgroundStopButton
      label={busyActionId === stopAction.id ? stopAction.busyLabel : item.stopLabel}
      disabled={busyActionId !== null}
      onclick={() => act(stopAction.id)}
      testid="background-item-{stopAction.id}"
    />
  {/if}
{/snippet}

<ActivityRow
  target={detailText}
  proseTarget
  actions={actionButtons}
  rail={elapsed || stopAction ? railItems : undefined}
  glyphClass={item.state === "failed" ? "is-destructive" : ""}
  testid="background-item-row"
>
  {#snippet glyph()}
    {#if item.state === "running"}
      <span class="activity-spinner" aria-hidden="true"></span>
    {:else if item.state === "waiting"}
      <WaitingIcon aria-hidden="true" />
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
