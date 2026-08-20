<script lang="ts">
  import { ChevronDown as CaretDownIcon, Check as CheckIcon, Clock as ClockIcon } from "@lucide/svelte";
  import DateTimePicker from "../ui/DateTimePicker.svelte";
  import * as Popover from "../ui/popover";
  import { Separator } from "../ui/separator";
  import {
    fromLocalInput,
    isApplicableAbsolute,
    rangeLabel,
    resolveRange,
    toLocalInput,
    RELATIVE_CHOICES,
    type TimeRange,
  } from "./lib/time-range";

  /**
   * The window every answer on the page is asked in.
   *
   * One control, both forms. The relative choices are what a user wants nine
   * times out of ten and stay true as the clock moves; the absolute pair is what
   * an investigation needs, because the incident sits between two instants and a
   * sliding window walks away from it.
   *
   * The custom edges are a draft until applied: half-typed dates must not fire a
   * query per keystroke, and an inverted pair is refused rather than answered
   * with an empty result that reads as "nothing happened".
   */
  interface Props {
    range: TimeRange;
    onRangeChange: (range: TimeRange) => void;
  }

  let { range, onRangeChange }: Props = $props();

  let open = $state(false);
  let draftFrom = $state("");
  let draftTo = $state("");

  const label = $derived(rangeLabel(range));
  const parsedFrom = $derived(fromLocalInput(draftFrom));
  const parsedTo = $derived(fromLocalInput(draftTo));
  const canApply = $derived(isApplicableAbsolute(parsedFrom, parsedTo));
  const invalidHint = $derived(
    draftFrom && draftTo && !canApply ? "The end must come after the start." : "",
  );

  // Opening seeds the draft from the window on screen, so a custom range is
  // edited from where the user already is rather than from an empty field.
  function seedDraft(next: boolean): void {
    if (!next) return;
    const window = resolveRange(range, Date.now());
    draftFrom = toLocalInput(window.from);
    draftTo = toLocalInput(window.to);
  }

  function chooseRelative(ms: number): void {
    onRangeChange({ kind: "relative", ms });
    open = false;
  }

  function applyAbsolute(): void {
    if (parsedFrom == null || parsedTo == null || !canApply) return;
    onRangeChange({ kind: "absolute", from: parsedFrom, to: parsedTo });
    open = false;
  }
</script>

<Popover.Root bind:open onOpenChange={seedDraft}>
  <Popover.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-insights-chrome whitespace-nowrap transition-[background-color,color,scale] hover:bg-[var(--wash-1)] active:scale-[0.96]"
        style="color:{range.kind === 'absolute' ? 'var(--primary)' : 'var(--foreground)'}"
        aria-label="Time range: {label}"
      >
        <ClockIcon size={11} class="opacity-70" />
        <span class="tabular-nums">{label}</span>
        <CaretDownIcon size={8} weight="bold" class="opacity-50" />
      </button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content
    data-solus-ui
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    aria-label="Time range"
    class="menu-surface z-[10002] w-72 gap-0 rounded-2xl bg-(--solus-menu-bg) p-1.5 shadow-[shadow:var(--solus-menu-shadow)] ring-0"
  >
    <div class="flex flex-col" role="listbox" aria-label="Relative range">
      {#each RELATIVE_CHOICES as choice (choice.ms)}
        {@const selected = range.kind === "relative" && range.ms === choice.ms}
        <button
          type="button"
          role="option"
          aria-selected={selected}
          class="flex h-7 cursor-pointer items-center justify-between rounded-md px-2 text-insights-chrome transition-colors hover:bg-muted"
          onclick={() => chooseRelative(choice.ms)}
        >
          {choice.label}
          {#if selected}
            <CheckIcon size={11} weight="bold" class="text-(--primary)" />
          {/if}
        </button>
      {/each}
    </div>

    <Separator class="my-1.5" />

    <div class="flex flex-col gap-1.5 px-1 pb-1">
      <span class="text-insights-chrome font-medium text-muted-foreground tracking-[0.07em] uppercase">Custom range</span>
      <div class="flex flex-col gap-0.5">
        <span class="px-0.5 text-insights-chrome text-muted-foreground">From</span>
        <DateTimePicker
          value={draftFrom}
          onChange={(value) => (draftFrom = value)}
          class="h-7 w-full text-insights-chrome"
        />
      </div>
      <div class="flex flex-col gap-0.5">
        <span class="px-0.5 text-insights-chrome text-muted-foreground">To</span>
        <DateTimePicker
          value={draftTo}
          onChange={(value) => (draftTo = value)}
          class="h-7 w-full text-insights-chrome"
        />
      </div>
      {#if invalidHint}
        <span class="text-insights-chrome" style="color:var(--failure)">{invalidHint}</span>
      {/if}
      <button
        type="button"
        class="mt-0.5 h-6.5 cursor-pointer rounded-lg bg-(--primary) text-insights-chrome font-medium text-(--primary-foreground) transition-opacity disabled:cursor-not-allowed"
        style="opacity:{canApply ? 1 : 0.35}"
        disabled={!canApply}
        onclick={applyAbsolute}>Apply range</button
      >
    </div>
  </Popover.Content>
</Popover.Root>
