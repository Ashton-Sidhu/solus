<script lang="ts">
  import type { Message } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts";
  import { formatActivityDuration } from "./lib/activity-summary";
  import {
    stepsFigure,
    subagentFigures,
    subagentReportPreview,
    subagentVerdict,
  } from "./lib/subagent-card";
  import type { SubagentRow } from "./lib/subagent-group";

  /**
   * §3b — a subagent once it lands. The row becomes a card because now there is
   * something to read: a page from the report rather than a summary of one.
   *
   * "Returned" joins the kicker as small caps instead of taking a pill — a
   * finished agent is not news, it is a state of the object. The one accent is the
   * rule under the header, which functions as a seal on the verdict; the verdict
   * itself is the agent's own first paragraph, set as prose rather than as UI.
   */
  interface Props {
    message: Message;
    row: SubagentRow;
    tabId: string;
    /** The checkout it ran in. Empty when the session isn't isolated. */
    worktree: string;
  }
  let { message, row, tabId, worktree }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  const verdict = $derived(subagentVerdict(message));
  const reportPreview = $derived(subagentReportPreview(message));
  const figures = $derived(subagentFigures(message));
  const steps = $derived(stepsFigure(row.steps));
  const elapsed = $derived(formatActivityDuration(row.elapsedMs));
  const transcript = $derived(message.subMessages?.length ?? 0);
  const isOpen = $derived(
    router.overlay?.name === "subagent" && router.overlay.params.messageId === row.id,
  );
</script>

<section
  class="return-card mx-auto text-transcript-meta w-[88%] overflow-hidden rounded-2xl bg-(--solus-tx-card-bg) pointer-fine:[.is-laptop-display_&]:rounded-xl"
  class:is-open={isOpen}
  aria-label="Sub-agent"
  data-testid="subagent-group"
>
  <div
    class="flex items-start gap-3 px-[1.0625rem] pt-4 pointer-fine:[.is-laptop-display_&]:px-3.5 pointer-fine:[.is-laptop-display_&]:pt-3"
    data-testid="subagent-card"
  >
    <div class="min-w-0 flex-1">
      <div class="mb-1.5 flex items-center gap-2">
        <span
          class="font-medium text-(--muted-foreground) uppercase opacity-60"
          >Subagent</span
        >
        <span
          class="h-[0.5625rem] w-px bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
          aria-hidden="true"
        ></span>
        <span
          class="flex items-center gap-1.5 font-medium text-(--muted-foreground) uppercase opacity-60"
        >
          <svg
            width="8"
            height="8"
            viewBox="0 0 12 12"
            fill="none"
            stroke="color-mix(in oklch, var(--solus-art-3) 60%, var(--foreground))"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"><path d="M2 6.3l2.7 2.7L10 3.4" /></svg
          >
          Returned
        </span>
      </div>
      <h3 class="m-0 text-transcript-card font-medium">
        {row.name}
      </h3>
    </div>
    <button
      type="button"
      class="-mt-0.5 shrink-0 cursor-pointer rounded-md border-none bg-transparent px-[0.6875rem] py-[0.3125rem] font-medium shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_15%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]"
      onclick={() => session.openSubagent(tabId, row.id)}>Open report</button
    >
  </div>

  {#if verdict}
    <div class="px-[1.0625rem] pt-3.5">
      <!-- The one piece of accent on the card, and it functions as a seal. -->
      <span
        class="mb-[0.6875rem] block h-[0.09375rem] w-[1.625rem] bg-[color-mix(in_oklch,var(--primary)_62%,transparent)]"
        aria-hidden="true"
      ></span>
      <p
        class="m-0  leading-[1.62] text-pretty"
        data-testid="subagent-verdict"
      >
        {verdict}
      </p>
    </div>
  {/if}

  {#if reportPreview.highlights.length > 0}
    <div class="flex flex-col px-[1.0625rem] pt-[0.9375rem]" data-testid="subagent-findings">
      {#each reportPreview.highlights as highlight, i (i)}
        <div
          class="border-t border-[color-mix(in_oklch,var(--foreground)_7%,transparent)] py-2.5"
        >
          <div
            class="font-medium text-(--muted-foreground) uppercase opacity-70"
          >
            {highlight.heading}
          </div>
          {#if highlight.finding}
            <p
              class="mt-1 mb-0 line-clamp-2  leading-[1.5] text-(--foreground) text-pretty"
            >
              {highlight.finding}
            </p>
          {/if}
        </div>
      {/each}
      {#if reportPreview.more > 0}
        <div
          class="border-t border-[color-mix(in_oklch,var(--foreground)_7%,transparent)] py-2 text-(--muted-foreground)"
        >
          +{reportPreview.more} more in report
        </div>
      {/if}
    </div>
  {/if}

  {#if figures.length > 0}
    <!-- A figure table, not a metadata row: counts align down one right edge, so
         they can be compared without being read as a sentence. -->
    <div class="flex flex-col px-[1.0625rem] pt-[0.9375rem]">
      {#each figures as item (item.label)}
        <div
          class="flex items-baseline gap-3.5 border-t border-[color-mix(in_oklch,var(--foreground)_7%,transparent)] py-2"
        >
          <span class="w-11 shrink-0 text-right tabular-nums">{item.figure}</span>
          <span class="flex-1  leading-[1.5] text-(--muted-foreground) text-pretty"
            >{item.label}{#if item.names.length > 0}
              — {#each item.names as name, i (name)}{#if i > 0}, {/if}<span
                  class="text-(--foreground)">{name}</span
                >{/each}{#if item.more > 0}<span class="opacity-70"> +{item.more} more</span
                >{/if}{/if}</span
          >
        </div>
      {/each}
    </div>
  {/if}

  <!-- A receipt: position, duration, model, transcript length, worktree. Rules
       instead of middots, because middots read as prose punctuation at this size. -->
  <div
    class="mt-3.5 flex items-center gap-2.5 border-t border-[color-mix(in_oklch,var(--foreground)_7%,transparent)] px-[1.0625rem] pt-2.5 pb-3"
  >
    <span
      class="flex items-baseline gap-2.5 text-(--muted-foreground) opacity-60"
    >
      {#if steps.total}
        <span class="tabular-nums">{steps.done}{steps.total}</span>
        <span
          class="h-[0.5625rem] w-px self-center bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
          aria-hidden="true"
        ></span>
      {/if}
      <span class="tabular-nums">{elapsed}</span>
      {#if row.meta}
        <span
          class="h-[0.5625rem] w-px self-center bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
          aria-hidden="true"
        ></span>
        <span>{row.meta}</span>
      {/if}
    </span>
    <span class="flex-1"></span>
    {#if transcript > 0}
      <span class="text-(--muted-foreground) tabular-nums opacity-55"
        >transcript {transcript}</span
      >
    {/if}
    {#if worktree}
      <span
        class="rounded bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] px-[0.4375rem] py-0.5 font-mono text-(--muted-foreground) shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_8%,transparent)]"
        >{worktree}</span
      >
    {/if}
  </div>
</section>

<style>
  /* Same shell as the running chassis — see the --solus-tx-card-* tokens. */
  .return-card {
    box-shadow: var(--solus-tx-card-shadow);
  }

  /* Which card the pane is showing, stated as a ring rather than a fill — the
     same signal the running chassis gives. It keeps the shared lift so an open
     card doesn't drop back down to the page. */
  .return-card.is-open {
    box-shadow:
      0 0 0 0.0625rem color-mix(in oklch, var(--primary) 34%, transparent),
      inset 0 0.0625rem 0 var(--solus-tx-card-highlight),
      var(--solus-tx-card-lift);
  }

  .return-card button:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.0625rem;
  }
</style>
