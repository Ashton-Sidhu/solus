<script lang="ts">
  import {
    Check as CheckIcon,
    CircleAlert as WarningCircleIcon,
    LoaderCircle as SpinnerIcon,
  } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { liveActivityClock } from "../../lib/shared-clock";
  import * as TooltipUI from "../ui/tooltip";
  import { formatActivityDuration } from "../conversation/lib/activity-summary";
  import PanelSection from "./PanelSection.svelte";
  import { railSubagentList, railSubagentTooltip } from "./lib/rail-subagents";

  /**
   * The session's sub-agents as a rail card: one row each, live ones first, so
   * a fan-out can be watched without scrolling the transcript back to its card.
   * A row opens the sub-agent pane beside the conversation — the same
   * destination the transcript card reaches — and the open one is marked.
   */
  interface Props {
    /** The conversation whose sub-agents these are. The pane opens off it. */
    tabId: string;
    /** The sub-agent tool calls, already filtered by the rail. */
    messages: Message[];
    collapsed: boolean;
    onToggle: () => void;
    onResizePointerDown?: (event: PointerEvent) => void;
  }
  let { tabId, messages, collapsed, onToggle, onResizePointerDown }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;
  const currentSession = $derived(session.sessionFor(tabId));

  // Read off the messages, not off the list — a clock the list depends on would
  // tear down and rebuild its own subscription on every tick.
  const runningCount = $derived(
    messages.filter((message) => message.toolStatus === "running").length,
  );
  let now = $state(Date.now());
  $effect(() => {
    if (runningCount === 0 || collapsed) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  const list = $derived(
    railSubagentList(messages, now, {
      model: (
        currentSession?.sessionModel ||
        currentSession?.run.modelConfig.modelId ||
        ""
      ).trim(),
      effort: (currentSession?.run.modelConfig.reasoningEffort || "").trim(),
    }),
  );

  const openMessageId = $derived(
    router.overlay?.name === "subagent" ? router.overlay.params.messageId : null,
  );

  function open(messageId: string) {
    session.openSubagent(tabId, messageId);
    requestInputFocus({ tabId });
  }
</script>

<PanelSection
  title="Subagents"
  headerDetail={list.detail}
  {collapsed}
  {onToggle}
  {onResizePointerDown}
>
  <!-- A session can fan out more agents than the rail has room for. Keep the
       group bounded so it does not push the rest of the rail off screen; the
       standard thumb shows while the pointer is over the list. -->
  <div
    class="scrollbar-on-hover mb-1 flex max-h-44 flex-col gap-px overflow-y-auto overscroll-contain"
  >
    {#each list.rows as row (row.id)}
      {@const isOpen = openMessageId === row.id}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="group flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-[0.4375rem] px-2 py-[0.3125rem] text-left transition-[background-color,color] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none {isOpen
                ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)'
                : 'text-(--solus-text-secondary)'}"
              aria-label={railSubagentTooltip(row)}
              aria-current={isOpen ? "true" : undefined}
              data-testid="rail-subagent-row"
              data-state={row.state}
              onclick={() => open(row.id)}
            >
              <!-- State is carried by the glyph alone, so the rows stay one
                   flat list: a spinner while it runs, a check when it lands,
                   the one colour that means failure when it dies. -->
              <span
                class="inline-flex size-[13px] shrink-0 items-center justify-center"
                aria-hidden="true"
              >
                {#if row.state === "running"}
                  <SpinnerIcon
                    size={13}
                    class="text-(--solus-status-running) motion-safe:animate-spin"
                  />
                {:else if row.state === "failed"}
                  <WarningCircleIcon size={13} class="text-(--solus-status-error)" />
                {:else}
                  <CheckIcon size={13} class="text-(--solus-status-complete)" />
                {/if}
              </span>
              <span class="min-w-0 flex-1 truncate">{row.name}</span>
              <!-- Reserve space for short durations and grow for longer ones. -->
              <span
                class="min-w-11 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-(--solus-text-tertiary)"
                >{formatActivityDuration(row.elapsedMs)}</span
              >
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content value={railSubagentTooltip(row)} />
      </TooltipUI.Root>
    {/each}
  </div>
</PanelSection>
