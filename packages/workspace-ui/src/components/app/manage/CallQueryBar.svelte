<script lang="ts">
  import { ArrowRight as RunIcon, Check as CheckIcon, ChevronDown as CaretDownIcon, Clock as ClockIcon, Search as SearchIcon, X as RemoveIcon } from "@lucide/svelte";
  import type { AppCallTerm } from "@solus/contracts/apps";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { CALL_RANGE_CHOICES, QUICK_QUERIES, type CallKind, type CallRange, type QuickQuery } from "./lib/activity";
  import { callTermLabel, parseCallQuery } from "./lib/call-query";

  /**
   * The query bar of the Activity section (docs/plans/apps.md §9.2), drawn as
   * the Insights query console (insights/QueryConsole.svelte): one card with
   * the query, the range, and Run; under them one quiet band with the saved
   * views, the filter chips, and the count. One log holds the calls and the
   * model calls; the Model calls view narrows it to the second. The console's
   * SQL editor, saved queries, and history are Insights' own, so the bar takes
   * its look, not the component. Enter runs the query. Field names take a
   * colour as the person types.
   */
  interface Props {
    /** The kind of call the view narrows to; '' for every call. The Model calls view shows as on while it is 'model'. */
    kind: CallKind;
    /** The text in the field; `applied` is the text the log shows. */
    text: string;
    applied: string;
    range: CallRange;
    chips: AppCallTerm[];
    /** "137 calls"; empty while the host has not answered. */
    count: string;
    onText: (text: string) => void;
    onRun: () => void;
    onRange: (range: CallRange) => void;
    onQuick: (query: QuickQuery) => void;
    onRemoveChip: (index: number) => void;
  }
  let { kind, text, applied, range, chips, count, onText, onRun, onRange, onQuick, onRemoveChip }: Props = $props();

  const parsed = $derived(parseCallQuery(text));
  const isDirty = $derived(text.trim() !== applied.trim());
  const rangeLabel = $derived(CALL_RANGE_CHOICES.find((choice) => choice.value === range)?.label ?? "");
  let scrollLeft = $state(0);
  let focused = $state(false);

  function onKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.key === "Enter") {
      event.preventDefault();
      onRun();
    } else if (event.key === "Escape" && text) {
      event.preventDefault();
      onText("");
    }
  }
</script>

<section
  class="w-full min-w-0 shrink-0 overflow-hidden rounded-xl bg-card"
  style="box-shadow:{focused
    ? '0 0 0 .5px var(--hairline-strongest), 0 0 0 3px color-mix(in oklch,var(--primary) 13%,transparent)'
    : 'var(--insights-card-shadow)'}"
  aria-label="Query"
  data-testid="app-call-query"
>
  <div class="flex min-h-12 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 py-2 pr-2 pl-2.5" role="search">
    <div class="flex h-8 min-w-48 flex-1 items-center gap-2.5">
      <SearchIcon size={12} class="shrink-0 text-muted-foreground opacity-70" aria-hidden="true" />
      <!-- The coloured pieces sit under the typed text, which is clear; they scroll with it. -->
      <div class="relative h-full min-w-0 flex-1 overflow-hidden font-mono text-insights-table">
        <div class="pointer-events-none absolute inset-y-0 left-0 flex items-center whitespace-pre" style="transform: translateX({-scrollLeft}px)" aria-hidden="true">
          {#each parsed.tokens as token, index (index)}<span
              class={token.kind === "field"
                ? "text-(--solus-art-5)"
                : token.kind === "operator"
                  ? "text-muted-foreground"
                  : token.kind === "invalid"
                    ? "text-(--failure) underline decoration-wavy decoration-(--failure)/60 underline-offset-4"
                    : "text-foreground"}>{token.text}</span>{/each}
        </div>
        <input
          class="relative h-full w-full min-w-0 bg-transparent text-transparent caret-foreground outline-none placeholder:font-sans placeholder:text-insights-query placeholder:text-muted-foreground selection:bg-(--solus-art-5)/20 selection:text-transparent"
          value={text}
          oninput={(event) => onText(event.currentTarget.value)}
          onscroll={(event) => (scrollLeft = event.currentTarget.scrollLeft)}
          onkeyup={(event) => (scrollLeft = event.currentTarget.scrollLeft)}
          onkeydown={onKeydown}
          onfocus={() => (focused = true)}
          onblur={() => (focused = false)}
          spellcheck={false}
          autocomplete="off"
          placeholder="Search, or operation:name or caller:workflow"
          aria-label="Query of the call log"
          aria-describedby={parsed.problem ? "app-call-query-problem" : undefined}
          data-testid="app-call-query-field"
        />
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-2.5">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class="flex h-7.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-insights-chrome whitespace-nowrap text-foreground transition-[background-color,color,scale] hover:bg-[var(--wash-1)] active:scale-[0.96] data-[state=open]:bg-[var(--wash-1)]"
              aria-label="Time range: {rangeLabel}"
            >
              <ClockIcon size={11} class="opacity-70" aria-hidden="true" />
              <span class="tabular-nums">{rangeLabel}</span>
              <CaretDownIcon size={8} class="opacity-50" aria-hidden="true" />
            </button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-44">
          {#each CALL_RANGE_CHOICES as choice (choice.value)}
            <DropdownMenu.Item onSelect={() => onRange(choice.value)}>
              <span class="min-w-0 flex-1 truncate">{choice.label}</span>
              {#if choice.value === range}<CheckIcon size={11} class="text-(--primary)" aria-hidden="true" />{/if}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <button
        type="button"
        class="flex size-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-[scale,opacity,background-color] active:scale-[0.96] {isDirty
          ? 'bg-(--primary) text-(--primary-foreground)'
          : 'bg-[var(--wash-2)] text-foreground hover:bg-[var(--wash-3)]'}"
        title="Run the query (Enter)"
        aria-label="Run the query"
        onclick={onRun}
      >
        <RunIcon size={12} aria-hidden="true" />
      </button>
    </div>
  </div>

  <!-- One quiet band under the field: what can be asked on the left, the filters and the count on the right. -->
  <div class="flex min-h-7.5 min-w-0 flex-wrap items-center gap-x-1 gap-y-1 px-2 py-0.5 shadow-[inset_0_0.5px_0_var(--hairline)]">
    <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" data-sb>
      {#each QUICK_QUERIES as quick, index (quick.label)}
        {@const isOn = "kind" in quick && quick.kind === kind}
        {#if index > 0}<span class="shrink-0 text-insights-chrome text-(--solus-text-tertiary)" aria-hidden="true">·</span>{/if}
        <button
          type="button"
          class="h-6 shrink-0 cursor-pointer rounded-md px-2 text-insights-chrome whitespace-nowrap outline-none transition-[background-color,color,box-shadow,scale] hover:bg-[var(--wash-1)] hover:text-foreground focus-visible:bg-[var(--wash-1)] focus-visible:text-foreground focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_38%,transparent)] active:scale-[0.96] {isOn
            ? 'font-medium text-foreground'
            : 'text-(--solus-text-secondary)'}"
          aria-pressed={"kind" in quick ? isOn : undefined}
          onclick={() => onQuick(quick)}>{quick.label}</button
        >
      {/each}
    </div>
    <div class="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      {#each chips as chip, index (`${chip.field}:${chip.value}`)}
        <span class="flex h-6 max-w-64 min-w-0 items-center gap-1 overflow-hidden rounded-md bg-[var(--wash-2)] pr-0.5 pl-2 text-insights-chrome text-foreground" data-testid="app-call-chip">
          <span class="truncate">{callTermLabel(chip)}</span>
          <button
            type="button"
            class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            aria-label="Remove the filter {callTermLabel(chip)}"
            onclick={() => onRemoveChip(index)}
          >
            <RemoveIcon size={12} aria-hidden="true" />
          </button>
        </span>
      {/each}
      <span class="shrink-0 pr-1 pl-1 text-insights-chrome text-muted-foreground tabular-nums" role="status">{count}</span>
    </div>
  </div>
  {#if parsed.problem}
    <p id="app-call-query-problem" class="m-0 px-2.5 py-2 text-insights-chrome text-(--failure) shadow-[inset_0_0.5px_0_var(--hairline)]">{parsed.problem}</p>
  {/if}
</section>
