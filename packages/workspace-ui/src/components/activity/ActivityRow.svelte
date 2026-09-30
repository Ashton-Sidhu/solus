<script lang="ts">
  import type { Activity } from "@solus/contracts/activity";
  import { modelLabelFor, type AgentId } from "@solus/contracts/types";
  import type { UserId } from "@solus/contracts/user";
  import { ArrowRight as ArrowRightIcon, Code as CodeIcon } from "@lucide/svelte";
  import UserChip from "../users/UserChip.svelte";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";
  import { activityLine } from "./lib/activity-line";

  /**
   * One activity as one sentence (plans/012 §5), wherever it is read: a divider
   * in the transcript, a line in the task timeline. A person other than the
   * reader is their user chip; anyone else is named in words ("You", "Your
   * agent"). The caller owns the frame around it.
   */
  interface Props {
    activity: Activity;
    /** The reader on the subject's host; "you" only for them. */
    self: UserId | null;
    /** Inside a divider: the chip shows the first name only. */
    short?: boolean;
    /** A divider's emphasised end: the source session, the branch, the plan, the agent. */
    title?: string;
    /** An agent switch's target model as the reader's picker has it now, for the switch still open. */
    targetModel?: string | null;
  }
  let { activity, self, short = false, title, targetModel = null }: Props = $props();

  const line = $derived(activityLine(activity, self));
  /** An agent switch whose two models are known reads as `from → to`. */
  const models = $derived.by(() => {
    if (activity.kind !== "agent_switched" || !activity.fromProvider) return null;
    const from = modelLabelFor(activity.fromProvider, activity.fromModel);
    const to = targetModel ?? modelLabelFor(activity.provider, activity.model);
    return from && to ? { fromProvider: activity.fromProvider, from, toProvider: activity.provider, to } : null;
  });
</script>

{#snippet agentGlyph(provider: AgentId)}
  <!-- The same model glyphs the model picker uses, in the accent. -->
  {#if provider === "claude-code"}
    <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-(--solus-accent)"><ClaudeIcon size={11} /></span>
  {:else if provider === "codex"}
    <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-white text-(--solus-accent)"><OpenAIBlossom size={11} /></span>
  {:else}
    <span class="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-(--solus-accent)"><CodeIcon size={11} /></span>
  {/if}
{/snippet}

<!-- In a divider the chip, the words, and the title centre on one line; the
     chip's own baseline nudge is tuned for running prose. -->
<span data-testid="activity-row" data-activity={activity.kind} class={short ? "inline-flex min-w-0 items-center gap-1 align-top" : ""}
  >{#if line.person}<UserChip user={line.person} {short} />{" "}{:else if line.who}{line.who}{" "}{/if}{#if models}<span
      class="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle leading-none"
      ><span class="inline-flex min-w-0 items-center gap-1"
        >{@render agentGlyph(models.fromProvider)}<span class="truncate">{models.from}</span></span
      ><ArrowRightIcon size={12} class="flex-shrink-0 text-(--solus-text-tertiary)" /><span
        class="inline-flex min-w-0 items-center gap-1 text-(--solus-accent)"
        >{@render agentGlyph(models.toProvider)}<span class="truncate">{models.to}</span></span
      ></span
    >{:else}{line.predicate}{#if title}{" "}<span class="inline-block max-w-50 truncate align-bottom text-(--solus-accent)">{title}</span>{/if}{/if}</span
>
