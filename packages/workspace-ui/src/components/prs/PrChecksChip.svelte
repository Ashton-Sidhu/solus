<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import {
    Check as CheckIcon,
    LoaderCircle as CircleNotchIcon,
    CircleMinus as MinusCircleIcon,
    CircleAlert as WarningCircleIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { CheckItem, PrChecksSummary } from "@solus/contracts/checks-types";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { checksChip, type ListChecksSpec } from "../ui/list-page/list-page";
  import * as Popover from "../ui/popover";
  import { PR_CHECKS_TONE } from "./lib/pr-row-styles";
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
    variant = "chip",
    rowChecks = { state: "none", label: "" },
    onOpen,
  }: {
    summary?: PrChecksSummary;
    headSha?: string | null;
    loadFailed?: boolean;
    /** Render nothing while checks pass so only non-passing states spend ink —
     *  a column of green "Passing" pills is noise, and even a dot reads as a
     *  stray speck in a list. The check details stay reachable from the PR's
     *  review surface. */
    quietWhenPassing?: boolean;
    /** `chip`: the tinted capsule with the state's word, where the chip is a
     *  standalone status object (review bar). `glyph`: the list row's bare
     *  14px icon, no word and no fill, the way a code host draws it — the
     *  details wait in the popover rather than spending ink on every row. */
    variant?: "chip" | "glyph";
    /** The glyph's state and words as the row already knows them from its
     *  listing, so the glyph is right before any check runs are read. */
    rowChecks?: ListChecksSpec;
    /** The popover opened: read the check runs now, not once per row. */
    onOpen?: () => void;
  } = $props();

  let open = $state(false);
  const display = $derived(checksPresentation(summary, headSha, loadFailed));
  const hidden = $derived(quietWhenPassing && display?.state === "passing");
  const glyph = $derived(variant === "glyph" ? checksChip(rowChecks) : null);

  function toggleFromGlyph(event: Event) {
    event.stopPropagation();
    event.preventDefault();
    open = !open;
  }

  function openDetails(item: CheckItem) {
    if (!item.detailsUrl) return;
    open = false;
    void localApi.openExternal(item.detailsUrl);
    requestInputFocus();
  }
</script>

{#snippet stateIcon(state: NonNullable<typeof display>["state"])}
  {#if state === "pending"}
    <CircleNotchIcon size={14} weight="bold" class="size-3.5 animate-spin [animation-duration:0.9s]" />
  {:else if state === "passing"}
    <CheckIcon size={14} weight="bold" class="size-3.5" />
  {:else if state === "failing"}
    <XIcon size={14} weight="bold" class="size-3.5" />
  {:else if state === "unavailable"}
    <WarningCircleIcon size={14} weight="fill" class="size-3.5" />
  {:else}
    <MinusCircleIcon size={14} weight="bold" class="size-3.5" />
  {/if}
{/snippet}

{#snippet checkIcon(item: CheckItem)}
  {#if item.inFlight}
    <CircleNotchIcon size={14} class="animate-spin text-chart-2 [animation-duration:0.9s]" />
  {:else if item.conclusion === "success" || item.conclusion === "neutral" || item.conclusion === "skipped"}
    <CheckIcon size={14} weight="bold" class="text-(--solus-art-positive)" />
  {:else if isFailing(item)}
    <XIcon size={14} weight="bold" class="text-(--solus-art-negative)" />
  {:else}
    <MinusCircleIcon size={14} class="text-muted-foreground" />
  {/if}
{/snippet}

{#snippet checkRow(item: CheckItem)}
  {#if item.detailsUrl}
    <!-- A list row mirroring the non-clickable branch below, not a button primitive. -->
    <button
      type="button"
      class="group/row flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)]"
      onclick={() => openDetails(item)}
    >
      {@render checkIcon(item)}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-normal text-foreground">{item.name}</span>
        {#if item.appName}
          <span class="block truncate text-xs text-muted-foreground">{item.appName}</span>
        {/if}
      </span>
      <span class="shrink-0 text-xs text-muted-foreground">{checkResultLabel(item)}</span>
    </button>
  {:else}
    <div class="flex items-center gap-2 rounded-lg px-2 py-1.5">
      {@render checkIcon(item)}
      <span class="min-w-0 flex-1">
        <span class="block truncate text-xs font-normal text-foreground">{item.name}</span>
        {#if item.appName}
          <span class="block truncate text-xs text-muted-foreground">{item.appName}</span>
        {/if}
      </span>
      <span class="shrink-0 text-xs text-muted-foreground">{checkResultLabel(item)}</span>
    </div>
  {/if}
{/snippet}

{#if display && !hidden && (variant === "chip" || glyph)}
  <!-- The state's colour rides on `currentColor`, so the badge's tint is one
       color-mix of it rather than a second per-state background list. -->
  {@const tone =
    display.state === "pending"
      ? "text-chart-2"
      : display.state === "passing"
        ? "text-(--solus-art-positive)"
        : display.state === "failing" || display.state === "unavailable"
          ? "text-(--solus-art-negative)"
          : "text-muted-foreground"}
  <!-- Stop list-row activation while the checks popover is being used. The
       span carries no behaviour of its own — the trigger inside is the control,
       and it is reachable by keyboard without the row also activating. -->
  <span
    class="inline-flex shrink-0"
    role="none"
    onclick={(event) => event.stopPropagation()}
  >
    <Popover.Root
      bind:open
      onOpenChange={(next) => {
        if (next) onOpen?.();
        else requestInputFocus();
      }}
    >
      <Popover.Trigger>
        {#snippet child({ props })}
          {#if glyph}
            <!-- A list row is itself a button, so the trigger is a span with the
                 button's role: a nested button is not valid inside one. Its own
                 click and keys open the popover without also selecting the row. -->
            <span
              {...props}
              role="button"
              tabindex="0"
              class="flex cursor-pointer items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] {PR_CHECKS_TONE[rowChecks.state]}"
              aria-label={glyph.label}
              title={glyph.label}
              onclick={toggleFromGlyph}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") toggleFromGlyph(event);
              }}
            >
              <glyph.icon size={14} aria-hidden="true" />
            </span>
          {:else}
            <Button
              {...props}
              type="button"
              aria-label={`${display.label}: ${display.tooltip}`}
              class={`inline-flex h-auto cursor-pointer items-center gap-1 rounded-full border-0 bg-[color:color-mix(in_oklab,currentColor_12%,transparent)] px-2 py-0.5 text-xs font-medium tabular-nums transition-colors ${tone}`}
              title={display.tooltip}
            >
              {@render stateIcon(display.state)}
              <span>{display.label}</span>
            </Button>
          {/if}
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        onOpenAutoFocus={(event) => event.preventDefault()}
        class="z-[10002] w-[18rem] gap-0 overflow-hidden rounded-2xl border-border bg-(--solus-popover-bg) p-0 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl"
      >
        <div role="dialog" aria-label="Check details">
          <div class="border-b border-border px-3 py-2">
            <p class="text-xs font-normal text-foreground">{display.label}</p>
            {#if summary}
              <p class="mt-0.5 text-xs tabular-nums text-muted-foreground">{checksCounts(summary)}</p>
            {:else}
              <p class="mt-0.5 text-pretty text-xs text-muted-foreground">{display.tooltip}</p>
            {/if}
          </div>

          {#if summary && summary.state !== "none"}
            <div class="max-h-[19rem] overflow-y-auto p-1.5">
              {#if summary.required.length > 0}
                <p class="px-2 pt-1 pb-0.5 text-xs font-normal text-muted-foreground uppercase">Required</p>
                {#each summary.required as item (item.id)}
                  {@render checkRow(item)}
                {/each}
              {/if}
              {#if summary.optional.length > 0}
                <p class="px-2 pt-2 pb-0.5 text-xs font-normal text-muted-foreground uppercase">Optional</p>
                {#each summary.optional as item (item.id)}
                  {@render checkRow(item)}
                {/each}
              {/if}
            </div>
          {:else if summary?.state === "none"}
            <p class="px-3 py-3 text-pretty text-xs leading-relaxed text-muted-foreground">No CI checks are configured for this pull request.</p>
          {/if}
        </div>
      </Popover.Content>
    </Popover.Root>
  </span>
{/if}
