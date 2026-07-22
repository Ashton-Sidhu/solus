<script lang="ts">
  import {
    CheckCircleIcon,
    CircleNotchIcon,
    MinusCircleIcon,
    WarningCircleIcon,
    XCircleIcon,
  } from "phosphor-svelte";
  import type { CheckItem, PrChecksSummary } from "../../../shared/checks-types";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as Popover from "../ui/popover";
  import {
    checkResultLabel,
    checksCounts,
    checksPresentation,
    isFailing,
  } from "./lib/checks";

  let {
    summary,
    headSha = null,
    loadFailed = false,
    quietWhenPassing = false,
  }: {
    summary?: PrChecksSummary;
    headSha?: string | null;
    loadFailed?: boolean;
    /** Render nothing while checks pass so only non-passing states spend ink —
     *  a column of green "Passing" pills is noise, and even a dot reads as a
     *  stray speck in a list. The check details stay reachable from the PR's
     *  review surface. */
    quietWhenPassing?: boolean;
  } = $props();

  let open = $state(false);
  const display = $derived(checksPresentation(summary, headSha, loadFailed));
  const hidden = $derived(quietWhenPassing && display?.state === "passing");

  function openDetails(item: CheckItem) {
    if (!item.detailsUrl) return;
    open = false;
    void window.solus.openExternal(item.detailsUrl);
    requestInputFocus();
  }
</script>

{#snippet stateIcon(state: NonNullable<typeof display>["state"])}
  {#if state === "pending"}
    <CircleNotchIcon size={11} weight="bold" class="size-[11px] animate-spin [animation-duration:0.9s]" />
  {:else if state === "passing"}
    <CheckCircleIcon size={11} weight="fill" class="size-[11px]" />
  {:else if state === "failing"}
    <XCircleIcon size={11} weight="fill" class="size-[11px]" />
  {:else if state === "unavailable"}
    <WarningCircleIcon size={11} weight="fill" class="size-[11px]" />
  {:else}
    <MinusCircleIcon size={11} weight="bold" class="size-[11px]" />
  {/if}
{/snippet}

{#snippet checkIcon(item: CheckItem)}
  {#if item.inFlight}
    <CircleNotchIcon size={12} class="animate-spin text-amber-600 [animation-duration:0.9s] dark:text-amber-400" />
  {:else if item.conclusion === "success" || item.conclusion === "neutral" || item.conclusion === "skipped"}
    <CheckCircleIcon size={12} weight="fill" class="text-(--solus-art-positive)" />
  {:else if isFailing(item)}
    <XCircleIcon size={12} weight="fill" class="text-(--solus-art-negative)" />
  {:else}
    <MinusCircleIcon size={12} class="text-(--solus-text-tertiary)" />
  {/if}
{/snippet}

{#snippet checkRow(item: CheckItem)}
  {#if item.detailsUrl}
    <!-- A list row mirroring the non-clickable branch below, not a button primitive. -->
    <button
      type="button"
      class="group/row flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-[background-color,scale] duration-100 ease-out hover:bg-(--solus-surface-hover) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)]"
      onclick={() => openDetails(item)}
    >
      {@render checkIcon(item)}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[0.6875rem] font-medium text-(--solus-text-secondary)">{item.name}</span>
        {#if item.appName}
          <span class="block truncate text-[0.5625rem] text-(--solus-text-tertiary)">{item.appName}</span>
        {/if}
      </span>
      <span class="shrink-0 text-[0.625rem] text-(--solus-text-tertiary)">{checkResultLabel(item)}</span>
    </button>
  {:else}
    <div class="flex items-center gap-2 rounded-lg px-2 py-1.5">
      {@render checkIcon(item)}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[0.6875rem] font-medium text-(--solus-text-secondary)">{item.name}</span>
        {#if item.appName}
          <span class="block truncate text-[0.5625rem] text-(--solus-text-tertiary)">{item.appName}</span>
        {/if}
      </span>
      <span class="shrink-0 text-[0.625rem] text-(--solus-text-tertiary)">{checkResultLabel(item)}</span>
    </div>
  {/if}
{/snippet}

{#if display && !hidden}
  <!-- Stop list-row activation while the checks popover is being used. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <span class="inline-flex shrink-0" onclick={(event) => event.stopPropagation()}>
    <Popover.Root bind:open onOpenChange={(next) => { if (!next) requestInputFocus(); }}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            type="button"
            aria-label={`${display.label}: ${display.tooltip}`}
            class="inline-flex h-auto cursor-pointer items-center gap-1 rounded-full px-1.5 py-px text-[0.625rem] leading-4 font-semibold tabular-nums shadow-[0_0_0_1px_color-mix(in_srgb,currentColor_16%,transparent)] transition-[background-color,color,box-shadow,scale] duration-100 ease-out active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] {display.state === 'pending'
              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
              : display.state === 'passing'
                ? 'bg-[color:color-mix(in_srgb,var(--solus-art-positive)_10%,transparent)] text-(--solus-art-positive)'
                : display.state === 'failing'
                  ? 'bg-[color:color-mix(in_srgb,var(--solus-art-negative)_9%,transparent)] text-(--solus-art-negative)'
                  : display.state === 'unavailable'
                    ? 'bg-[color:color-mix(in_srgb,var(--solus-art-negative)_7%,transparent)] text-(--solus-art-negative)'
                    : 'bg-(--solus-art-raised) text-(--solus-text-tertiary)'}"
            title={display.tooltip}
          >
            {@render stateIcon(display.state)}
            <span>{display.label}</span>
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        class="z-[10002] w-[18rem] gap-0 overflow-hidden rounded-xl border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl"
      >
        <div role="dialog" aria-label="Check details">
          <div class="border-b border-(--solus-popover-border) px-3 py-2">
            <p class="text-[0.6875rem] font-semibold text-(--solus-text-secondary)">{display.label}</p>
            {#if summary}
              <p class="mt-0.5 text-[0.625rem] tabular-nums text-(--solus-text-tertiary)">{checksCounts(summary)}</p>
            {:else}
              <p class="mt-0.5 text-pretty text-[0.625rem] text-(--solus-text-tertiary)">{display.tooltip}</p>
            {/if}
          </div>

          {#if summary && summary.state !== "none"}
            <div class="max-h-[19rem] overflow-y-auto p-1.5 [scrollbar-width:thin]">
              {#if summary.required.length > 0}
                <p class="px-2 pt-1 pb-0.5 text-[0.5625rem] font-semibold tracking-[0.08em] text-(--solus-text-tertiary) uppercase">Required</p>
                {#each summary.required as item (item.id)}
                  {@render checkRow(item)}
                {/each}
              {/if}
              {#if summary.optional.length > 0}
                <p class="px-2 pt-2 pb-0.5 text-[0.5625rem] font-semibold tracking-[0.08em] text-(--solus-text-tertiary) uppercase">Optional</p>
                {#each summary.optional as item (item.id)}
                  {@render checkRow(item)}
                {/each}
              {/if}
            </div>
          {:else if summary?.state === "none"}
            <p class="px-3 py-3 text-pretty text-[0.6875rem] leading-relaxed text-(--solus-text-tertiary)">No CI checks are configured for this pull request.</p>
          {/if}
        </div>
      </Popover.Content>
    </Popover.Root>
  </span>
{/if}
