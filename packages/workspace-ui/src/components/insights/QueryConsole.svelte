<script lang="ts">
  import {
    ArrowRight as ArrowRightIcon,
    Bookmark as BookmarkSimpleIcon,
    LoaderCircle as CircleNotchIcon,
    History as ClockCounterClockwiseIcon,
    Ellipsis as DotsThreeIcon,
    Maximize2 as ArrowsOutIcon,
    Minimize2 as ArrowsInIcon,
    Search as MagnifyingGlassIcon,
    Table as TableIcon,
  } from "@lucide/svelte";
  import { formatAge, formatRowCount } from "./lib/format";
  import { presetsFor, type InsightsPreset } from "./lib/insights-queries";
  import type { SqlEditorSources } from "./lib/sql-editor-extensions";
  import type { TimeRange } from "./lib/time-range";
  import type { QueryForm, QueryRunRecord } from "./insights.store.svelte";
  import type { SavedMetricsQuery } from "@solus/contracts/observability-types";
  import SavedQueryContextMenu from "./SavedQueryContextMenu.svelte";
  import SqlEditor from "./SqlEditor.svelte";
  import TimeRangePicker from "./TimeRangePicker.svelte";
  import { Input } from "../ui/input";

  /**
   * The one place a question is asked, in either language: English, which an
   * agent compiles, or SQLite, which the user writes. Both land in the same
   * guarded executor, and a compile leaves its statement in the SQL tab — a
   * generated query the user cannot inspect is not a query they can trust, and
   * the tab it is already written in is where they would go to read it.
   */
  interface Props {
    form: QueryForm;
    onFormChange: (form: QueryForm) => void;
    question: string;
    onQuestionChange: (question: string) => void;
    sqlText: string;
    onSqlChange: (sql: string) => void;
    onRun: (form?: QueryForm) => void;
    running: boolean;
    /** The window the question is asked in — part of the question, so its
     *  control lives on the console rather than in the page chrome. */
    range: TimeRange;
    onRangeChange: (range: TimeRange) => void;
    resultNote: string;
    schemaRevision: number;
    /** Whether the schema sheet is on screen — the console owns the control
     *  that opens it, the page owns the sheet itself. */
    schemaOpen: boolean;
    onOpenSchema: () => void;
    sources: SqlEditorSources;
    savedQueries: SavedMetricsQuery[];
    history: QueryRunRecord[];
    /** Shipped chips for the active tab, already written at the selected time
     *  range — the console shows presets, it does not decide them. */
    presets: InsightsPreset[];
    onPreset: (preset: InsightsPreset) => void;
    onSaved: (query: SavedMetricsQuery) => void;
    onDeleteSaved: (id: string) => void;
    onSaveCurrent: () => void;
    onHistory: (run: QueryRunRecord) => void;
    /** Mobile composes nothing in v1: presets and saved queries only. */
    readOnly?: boolean;
  }

  let {
    form,
    onFormChange,
    question,
    onQuestionChange,
    sqlText,
    onSqlChange,
    onRun,
    running,
    range,
    onRangeChange,
    resultNote,
    schemaRevision,
    schemaOpen,
    onOpenSchema,
    sources,
    savedQueries,
    history,
    presets,
    onPreset,
    onSaved,
    onDeleteSaved,
    onSaveCurrent,
    onHistory,
    readOnly = false,
  }: Props = $props();

  let focused = $state(false);
  let panel = $state<"none" | "history">("none");
  let now = $state(Date.now());
  let sqlEditor = $state<ReturnType<typeof SqlEditor> | null>(null);
  let popoutSqlEditor = $state<ReturnType<typeof SqlEditor> | null>(null);
  let editorPopoutOpen = $state(false);
  let popoutForm = $state<QueryForm>("sql");
  /** The saved chip whose menu is on screen, anchored where it was summoned —
   *  a right-click lands at the pointer, the chip's own button under itself. */
  let savedMenu = $state<{ query: SavedMetricsQuery; x: number; y: number } | null>(null);

  /**
   * Write text into the query being composed, at the cursor when the editor is
   * mounted. The schema sheet calls this; in the natural-language tab there is
   * no editor to hold a cursor, so the text is appended to the SQL draft the
   * user will land in.
   */
  export function insertIntoSql(text: string): void {
    if (sqlEditor) sqlEditor.insertAtCursor(text);
    else onSqlChange(sqlText.trim() ? `${sqlText} ${text}` : text);
  }

  function canRun(queryForm: QueryForm): boolean {
    return (queryForm === "nl" ? question : sqlText).trim().length > 0 && !running;
  }

  // Two words, not two banners: the language is a property of the question, so
  // it sits inside the field rather than on a band of its own.
  const TABS: { id: QueryForm; label: string; title: string }[] = [
    { id: "nl", label: "Ask", title: "Natural language — ⌥1" },
    { id: "sql", label: "SQL", title: "SQL — ⌥2" },
  ];

  // History ages count in minutes, so the panel ticks rather than freezing at
  // whatever the clock said when it opened.
  $effect(() => {
    if (panel !== "history") return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  function onKey(event: KeyboardEvent, queryForm: QueryForm): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onRun(queryForm);
    }
  }

  function openSavedMenu(query: SavedMetricsQuery, event: MouseEvent): void {
    event.preventDefault();
    savedMenu = { query, x: event.clientX, y: event.clientY };
  }

  /** The keyboard and pointer path that does not start at a pointer position:
   *  anchor under the chip's own control so the menu points at its owner. */
  function openSavedMenuAt(query: SavedMetricsQuery, element: HTMLElement): void {
    const rect = element.getBoundingClientRect();
    savedMenu = { query, x: rect.left, y: rect.bottom + 4 };
  }

  function toggleHistory(): void {
    panel = panel === "history" ? "none" : "history";
  }

  function openEditorPopout(): void {
    popoutForm = form;
    editorPopoutOpen = true;
    queueMicrotask(() => popoutSqlEditor?.focus());
  }

  function closeEditorPopout(): void {
    editorPopoutOpen = false;
    queueMicrotask(() => sqlEditor?.focus());
  }

  const consoleShadow = $derived(
    focused
      ? "0 0 0 .5px var(--hairline-strongest), 0 0 0 3px color-mix(in oklch,var(--primary) 13%,transparent)"
      : "var(--insights-card-shadow)",
  );
</script>

{#snippet consoleSurface(isPopout: boolean)}
{@const activeForm = isPopout ? popoutForm : form}
{@const surfacePresets = isPopout ? presetsFor(activeForm, range) : presets}
<section
  class="w-full shrink-0 overflow-hidden bg-card {isPopout ? 'rounded-none' : 'rounded-xl'}"
  style="box-shadow:{consoleShadow}"
  aria-label="Query console"
>
  <!-- The language segment: two words inside the field, so the console reads as
       one control rather than a stack of bands. -->
  {#snippet languageSegment()}
    <div
      class="flex h-6.5 shrink-0 items-center gap-0.5 rounded-lg bg-[var(--wash-1)] p-0.5"
      role="tablist"
      aria-label="Query language"
    >
      {#each TABS as tab (tab.id)}
        <button
          type="button"
          role="tab"
          aria-selected={activeForm === tab.id}
          title={tab.title}
          class="flex h-5.5 cursor-pointer items-center rounded-md px-2 text-insights-chrome font-medium transition-[background-color,color]"
          style="color:{activeForm === tab.id
            ? 'var(--foreground)'
            : 'var(--muted-foreground)'};background:{activeForm === tab.id
            ? 'var(--card)'
            : 'transparent'};box-shadow:{activeForm === tab.id ? 'var(--elev-ring)' : 'none'}"
          onclick={() => (isPopout ? (popoutForm = tab.id) : onFormChange(tab.id))}
        >
          {tab.label}
        </button>
      {/each}
    </div>
  {/snippet}

  {#snippet runButton()}
    <button
      type="button"
      class="flex size-7.5 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-(--primary) text-(--primary-foreground) transition-[scale,opacity] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100 [.is-laptop-display_&]:size-6.5"
      disabled={!canRun(activeForm)}
      onclick={() => onRun(activeForm)}
      title="Run — ⌘↵"
      aria-label="Run the query"
    >
      {#if running}
        <CircleNotchIcon
          size={12}
          class="animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      {:else}
        <ArrowRightIcon size={12} weight="bold" aria-hidden="true" />
      {/if}
    </button>
  {/snippet}

  <!-- The hairline sweep says a run is in flight even when the eye is on the
       input, not the note — finite by construction: it leaves with `running`. -->
  {#snippet runningSweep()}
    {#if running}
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden" aria-hidden="true">
        <div class="running-sweep h-full w-1/3 bg-(--primary)"></div>
      </div>
    {/if}
  {/snippet}

  {#if activeForm === "nl"}
    <div class="relative flex h-12 items-center gap-2.5 pr-2 pl-2.5 [.is-laptop-display_&]:h-11">
      {@render languageSegment()}
      <MagnifyingGlassIcon size={12} class="shrink-0 text-muted-foreground opacity-70" />
      <div class="flex min-w-0 flex-1 items-center gap-1">
        <div class="min-w-0 flex-1">
          <Input
            class="h-auto rounded-none border-0 bg-transparent p-0 text-insights-query shadow-none focus-visible:ring-0 dark:bg-transparent"
            placeholder="Which sessions were slowest after 21:00?"
            value={question}
            disabled={readOnly}
            oninput={(event) => onQuestionChange(event.currentTarget.value)}
            onkeydown={(event) => onKey(event, activeForm)}
            onfocus={() => (focused = true)}
            onblur={() => (focused = false)}
            aria-label="Ask a question about your sessions"
            mic
          />
        </div>
        <div class="flex shrink-0 items-center gap-2.5">
          <TimeRangePicker {range} {onRangeChange} />
          {@render runButton()}
        </div>
      </div>
      {@render runningSweep()}
    </div>
  {:else}
    <div
      class="relative flex items-start gap-2.5 py-2 pr-2 pl-2.5"
      onfocusin={() => (focused = true)}
      onfocusout={() => (focused = false)}
    >
      {@render languageSegment()}
      <div class="min-w-0 flex-1">
        {#if isPopout}
          <SqlEditor
            bind:this={popoutSqlEditor}
            value={sqlText}
            onValueChange={onSqlChange}
            onRun={() => onRun(activeForm)}
            {sources}
            {schemaRevision}
            surface="popout"
          />
        {:else}
          <SqlEditor
            bind:this={sqlEditor}
            value={sqlText}
            onValueChange={onSqlChange}
            onRun={() => onRun(activeForm)}
            {sources}
            {schemaRevision}
            readOnly={readOnly}
          />
        {/if}
      </div>
      <TimeRangePicker {range} {onRangeChange} />
      {@render runButton()}
      {@render runningSweep()}
    </div>
  {/if}

  <!-- One quiet band under the field: what can be asked on the left, what the
       last run did and where to look it up on the right. -->
  <div
    class="flex h-7.5 items-center gap-1 px-2 shadow-[inset_0_0.5px_0_var(--hairline)]"
  >
    <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" data-sb>
      {#each surfacePresets as preset (preset.id)}
        <button
          type="button"
          title={preset.description}
          class="h-6 shrink-0 cursor-pointer rounded-md px-2 text-insights-chrome whitespace-nowrap text-muted-foreground transition-[background-color,color,box-shadow,scale] hover:bg-[var(--wash-1)] hover:text-foreground hover:shadow-[shadow:var(--elev-ring)] active:scale-[0.96]"
          onclick={() => onPreset(preset)}>{preset.label}</button
        >
      {/each}
      {#if surfacePresets.length > 0 && savedQueries.length > 0}
        <span class="mx-1 h-3.5 w-px shrink-0 bg-(--hairline)" aria-hidden="true"></span>
      {/if}
      {#each savedQueries as saved (saved.id)}
        <!-- A question the user kept, so it wears their mark and answers to a
             menu rather than to a delete glyph sitting beside its name. -->
        <div
          class="group/saved flex h-6 shrink-0 items-center rounded-md pr-0.5 transition-[background-color,box-shadow] hover:bg-[var(--wash-1)] hover:shadow-[shadow:var(--elev-ring)]"
          oncontextmenu={(event) => openSavedMenu(saved, event)}
        >
          <button
            type="button"
            class="flex h-6 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-2 text-insights-chrome whitespace-nowrap transition-[scale] active:scale-[0.96]"
            title="Run “{saved.name}”"
            onclick={() => onSaved(saved)}
          >
            <BookmarkSimpleIcon
              size={10}
              weight="fill"
              class="shrink-0 text-(--primary) opacity-70"
              aria-hidden="true"
            />
            <span class="max-w-40 truncate">{saved.name}</span>
          </button>
          <button
            type="button"
            class="flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-[opacity,color] group-hover/saved:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-60"
            aria-haspopup="menu"
            title="More actions"
            aria-label="Actions for saved query {saved.name}"
            onclick={(event) => openSavedMenuAt(saved, event.currentTarget)}
          >
            <DotsThreeIcon size={12} weight="bold" aria-hidden="true" />
          </button>
        </div>
      {/each}
    </div>
    <span
      class="flex min-w-0 shrink items-center gap-1.5 pl-1 text-insights-chrome text-muted-foreground"
    >
      <span class="truncate" aria-live="polite">{resultNote}</span>
    </span>
    {#if !readOnly}
      <button
        type="button"
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,scale] hover:bg-[var(--wash-1)] hover:text-foreground active:scale-[0.96]"
        onclick={isPopout ? closeEditorPopout : openEditorPopout}
        title={isPopout ? "Return to Insights" : "Open the query console in a focused view"}
        aria-label={isPopout ? "Close focused query console" : "Open query console"}
      >
        {#if isPopout}
          <ArrowsInIcon size={12} aria-hidden="true" />
        {:else}
          <ArrowsOutIcon size={12} aria-hidden="true" />
        {/if}
      </button>
    {/if}
    {#if !readOnly}
      <button
        type="button"
        class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
        onclick={onSaveCurrent}
        title="Save this query"
        aria-label="Save this query"><BookmarkSimpleIcon size={12} /></button
      >
    {/if}
    <button
      type="button"
      class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
      style="color:{panel === 'history' ? 'var(--foreground)' : 'var(--muted-foreground)'}"
      aria-expanded={panel === "history"}
      title="Queries you have run"
      aria-label="Query history"
      onclick={toggleHistory}><ClockCounterClockwiseIcon size={12} /></button
    >
    <button
      type="button"
      class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
      style="color:{schemaOpen ? 'var(--foreground)' : 'var(--muted-foreground)'}"
      aria-expanded={schemaOpen}
      aria-haspopup="dialog"
      title="What you can query — ⌥S"
      aria-label="Schema"
      onclick={onOpenSchema}><TableIcon size={12} /></button
    >
  </div>


  {#if panel === "history"}
    <div class="overflow-hidden shadow-[inset_0_0.5px_0_var(--hairline)]">
      {#if history.length === 0}
        <p class="px-2.5 py-2.5 text-insights-chrome text-muted-foreground">
          Queries you run appear here for the rest of the session.
        </p>
      {:else}
        {#each history as run, index (run.id)}
          <button
            type="button"
            class="grid h-7.5 w-full cursor-pointer grid-cols-[1fr_4.75rem_3.625rem_3.375rem] items-center gap-3 px-2.5 text-left transition-colors hover:bg-[var(--wash-1)]"
            style="box-shadow:{index ? 'inset 0 0.5px 0 var(--hairline)' : 'none'}"
            onclick={() => onHistory(run)}
          >
            <span class="truncate text-insights-chrome">{run.text.replace(/\s+/g, " ")}</span>
            <span class="text-right text-insights-chrome tabular-nums text-muted-foreground"
              >{formatRowCount(run.rowCount)}</span
            >
            <span class="text-right text-insights-chrome tabular-nums text-muted-foreground"
              >{run.tookMs}ms</span
            >
            <span class="text-right text-insights-chrome tabular-nums text-muted-foreground"
              >{formatAge(run.at, now)}</span
            >
          </button>
        {/each}
      {/if}
    </div>
  {/if}

</section>
{/snippet}

{@render consoleSurface(false)}

{#if editorPopoutOpen}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    data-solus-ui
    class="fixed inset-0 z-[10020] flex items-center justify-center bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] p-6 pointer-events-auto motion-safe:animate-[backdrop-fade_140ms_ease-out] [.is-laptop-display_&]:p-4"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) closeEditorPopout();
    }}
    onkeydown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeEditorPopout();
      }
    }}
  >
    <div
      class="sql-popout-enter max-h-[min(82vh,48rem)] w-[min(76rem,calc(100vw-4rem))] overflow-x-hidden overflow-y-auto rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-card shadow-[0_0_0_0.5px_var(--hairline-strongest),0_0_0_3px_color-mix(in_oklch,var(--primary)_11%,transparent),var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.34)] [.dark_&]:shadow-[0_0_0_0.5px_var(--hairline-strongest),0_0_0_3px_color-mix(in_oklch,var(--primary)_13%,transparent),var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.55)] [.is-laptop-display_&]:max-h-[min(76vh,36rem)] [.is-laptop-display_&]:w-[min(66rem,calc(100vw-2rem))]"
      data-sb
      role="dialog"
      aria-label="Focused query console"
      aria-modal="true"
    >
      {@render consoleSurface(true)}
    </div>
  </div>
{/if}

{#if savedMenu}
  {@const query = savedMenu.query}
  <SavedQueryContextMenu
    x={savedMenu.x}
    y={savedMenu.y}
    {query}
    canDelete={!readOnly}
    onOpen={() => onSaved(query)}
    onDelete={() => onDeleteSaved(query.id)}
    onClose={() => (savedMenu = null)}
  />
{/if}

<style>
  .running-sweep {
    animation: running-sweep 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }

  @keyframes running-sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }

  .sql-popout-enter {
    animation: sql-popout-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  }

  @media (prefers-reduced-motion: reduce) {
    .running-sweep {
      animation: none;
      width: 100%;
      opacity: 0.4;
    }

    .sql-popout-enter {
      animation: none;
    }
  }

  @keyframes sql-popout-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.25rem, 0) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
