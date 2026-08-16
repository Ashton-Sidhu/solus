<script lang="ts">
  import { MagnifyingGlassIcon, PlusIcon } from "phosphor-svelte";
  import type { MetricsSchema } from "../../../shared/observability-types";
  import { formatAge, formatRowCount } from "./lib/format";
  import { presetsFor, type InsightsPreset } from "./lib/insights-queries";
  import type { SqlEditorSources } from "./lib/sql-editor-extensions";
  import type { QueryForm, QueryRunRecord } from "./insights.store.svelte";
  import type { SavedMetricsQuery } from "../../../shared/observability-types";
  import SqlEditor from "./SqlEditor.svelte";

  /**
   * The one place a question is asked, in either language: English, which an
   * agent compiles, or SQLite, which the user writes. Both land in the same
   * guarded executor, and the compiled SQL is always visible and openable —
   * a generated query the user cannot inspect is not a query they can trust.
   */
  interface Props {
    form: QueryForm;
    onFormChange: (form: QueryForm) => void;
    question: string;
    onQuestionChange: (question: string) => void;
    sqlText: string;
    onSqlChange: (sql: string) => void;
    onRun: () => void;
    running: boolean;
    /** SQL the NL compile produced for the question on screen. */
    compiledSql: string;
    resultNote: string;
    schema: MetricsSchema | null;
    schemaRevision: number;
    sources: SqlEditorSources;
    savedQueries: SavedMetricsQuery[];
    history: QueryRunRecord[];
    showInternals: boolean;
    onPreset: (preset: InsightsPreset) => void;
    onSaved: (query: SavedMetricsQuery) => void;
    onDeleteSaved: (id: string) => void;
    onSaveCurrent: () => void;
    onHistory: (run: QueryRunRecord) => void;
    onOpenInEditor: () => void;
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
    compiledSql,
    resultNote,
    schema,
    schemaRevision,
    sources,
    savedQueries,
    history,
    showInternals,
    onPreset,
    onSaved,
    onDeleteSaved,
    onSaveCurrent,
    onHistory,
    onOpenInEditor,
    readOnly = false,
  }: Props = $props();

  let focused = $state(false);
  let panel = $state<"none" | "history" | "schema">("none");
  let now = $state(Date.now());

  const presets = $derived(presetsFor(form, showInternals));
  const canRun = $derived((form === "nl" ? question : sqlText).trim().length > 0 && !running);
  const visibleViews = $derived(
    (schema?.views ?? []).filter((view) => showInternals || !view.internal),
  );

  const TABS: { id: QueryForm; label: string; hint: string }[] = [
    { id: "nl", label: "Natural language", hint: "⌥1" },
    { id: "sql", label: "SQL", hint: "⌥2" },
  ];

  // History ages count in minutes, so the panel ticks rather than freezing at
  // whatever the clock said when it opened.
  $effect(() => {
    if (panel !== "history") return;
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onRun();
    }
  }

  function togglePanel(next: "history" | "schema"): void {
    panel = panel === next ? "none" : next;
  }

  const consoleShadow = $derived(
    focused
      ? "0 0 0 .5px var(--hairline-strongest), 0 0 0 3px color-mix(in oklch,var(--primary) 13%,transparent)"
      : "var(--elev-ring)",
  );
</script>

<section
  class="shrink-0 overflow-hidden rounded-2xl bg-card"
  style="box-shadow:{consoleShadow}"
  aria-label="Query console"
>
  <div
    class="flex h-9 items-center gap-5 px-5 shadow-[inset_0_-0.5px_0_var(--hairline)]"
    role="tablist"
    aria-label="Query language"
  >
    {#each TABS as tab (tab.id)}
      <button
        type="button"
        role="tab"
        aria-selected={form === tab.id}
        class="flex h-full shrink-0 cursor-pointer items-center gap-2 text-xs font-medium transition-colors"
        style="color:{form === tab.id
          ? 'var(--foreground)'
          : 'var(--muted-foreground)'};box-shadow:{form === tab.id
          ? 'inset 0 -2px 0 var(--primary)'
          : 'none'}"
        onclick={() => onFormChange(tab.id)}
      >
        {tab.label}
        <span class="text-[0.625rem] opacity-55">{tab.hint}</span>
      </button>
    {/each}
    <span class="flex-1"></span>
    <span class="truncate text-[0.625rem] text-muted-foreground">{resultNote}</span>
  </div>

  {#if form === "nl"}
    <div class="flex h-13 items-center gap-3 px-5">
      <MagnifyingGlassIcon size={13} class="shrink-0 text-muted-foreground opacity-80" />
      <input
        class="min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none"
        placeholder="Which sessions were slowest after 21:00?"
        value={question}
        disabled={readOnly}
        oninput={(event) => onQuestionChange(event.currentTarget.value)}
        onkeydown={onKey}
        onfocus={() => (focused = true)}
        onblur={() => (focused = false)}
        aria-label="Ask a question about your sessions"
      />
      <div class="flex shrink-0 items-center gap-2.5">
        <span class="text-[0.625rem] text-muted-foreground opacity-65">⌘↵</span>
        <button
          type="button"
          class="h-7 cursor-pointer rounded-lg bg-(--primary) px-3.5 text-xs font-medium text-(--primary-foreground) transition-opacity disabled:cursor-not-allowed"
          style="opacity:{canRun ? 1 : 0.35}"
          disabled={!canRun}
          onclick={onRun}>{running ? "Running" : "Run"}</button
        >
      </div>
    </div>
  {:else}
    <div class="flex items-start gap-4 px-5 py-3">
      <div class="min-w-0 flex-1">
        <SqlEditor
          value={sqlText}
          onValueChange={onSqlChange}
          {onRun}
          {sources}
          {schemaRevision}
          readOnly={readOnly}
        />
      </div>
      <div class="flex shrink-0 flex-col items-end gap-2">
        <button
          type="button"
          class="h-7 cursor-pointer rounded-lg bg-(--primary) px-3.5 text-xs font-medium text-(--primary-foreground) transition-opacity disabled:cursor-not-allowed"
          style="opacity:{canRun ? 1 : 0.35}"
          disabled={!canRun}
          onclick={onRun}>{running ? "Running" : "Run"}</button
        >
        <span class="text-[0.625rem] text-muted-foreground opacity-65">⌘↵</span>
      </div>
    </div>
  {/if}

  <div
    class="flex h-8.5 items-center gap-2 bg-[var(--wash-1)] px-5 shadow-[inset_0_0.5px_0_var(--hairline)]"
  >
    <span
      class="shrink-0 text-[0.5938rem] font-medium whitespace-nowrap text-muted-foreground uppercase"
      >{form === "nl" ? "Questions" : "Queries"}</span
    >
    <div class="flex min-w-0 items-center gap-1.5 overflow-x-auto" data-sb>
      {#each presets as preset (preset.id)}
        <button
          type="button"
          title={preset.description}
          class="h-5.5 shrink-0 cursor-pointer rounded-full px-2.5 text-[0.6875rem] whitespace-nowrap text-muted-foreground shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted"
          onclick={() => onPreset(preset)}>{preset.label}</button
        >
      {/each}
      {#each savedQueries as saved (saved.id)}
        <span class="group/saved flex shrink-0 items-center">
          <button
            type="button"
            class="h-5.5 cursor-pointer rounded-full px-2.5 text-[0.6875rem] whitespace-nowrap shadow-[shadow:var(--elev-ring)] transition-colors hover:bg-muted"
            onclick={() => onSaved(saved)}>{saved.name}</button
          >
          <button
            type="button"
            class="ml-0.5 hidden cursor-pointer text-[0.625rem] text-muted-foreground group-hover/saved:block hover:text-(--failure)"
            onclick={() => onDeleteSaved(saved.id)}
            aria-label="Delete saved query {saved.name}">×</button
          >
        </span>
      {/each}
    </div>
    <span class="flex-1"></span>
    {#if !readOnly}
      <button
        type="button"
        class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted"
        onclick={onSaveCurrent}
        title="Save this query"
        aria-label="Save this query"><PlusIcon size={10} weight="bold" /></button
      >
    {/if}
    <button
      type="button"
      class="shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-[0.6875rem] transition-colors hover:bg-muted"
      style="color:{panel === 'history' ? 'var(--foreground)' : 'var(--muted-foreground)'}"
      aria-expanded={panel === "history"}
      onclick={() => togglePanel("history")}>History</button
    >
    <button
      type="button"
      class="shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-[0.6875rem] transition-colors hover:bg-muted"
      style="color:{panel === 'schema' ? 'var(--foreground)' : 'var(--muted-foreground)'}"
      aria-expanded={panel === "schema"}
      onclick={() => togglePanel("schema")}>Schema</button
    >
  </div>

  {#if form === "nl" && compiledSql}
    <div
      class="flex h-7.5 items-center gap-2.5 px-5 shadow-[inset_0_0.5px_0_var(--hairline)]"
    >
      <span
        class="shrink-0 text-[0.5938rem] font-medium whitespace-nowrap text-muted-foreground uppercase"
        >Compiled</span
      >
      <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-muted-foreground"
        >{compiledSql.replace(/\s+/g, " ")}</span
      >
      <button
        type="button"
        class="shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-[0.6875rem] whitespace-nowrap text-(--primary) transition-colors hover:bg-muted"
        onclick={onOpenInEditor}>Open in SQL editor</button
      >
    </div>
  {/if}

  {#if panel === "history"}
    <div class="overflow-hidden shadow-[inset_0_0.5px_0_var(--hairline)]">
      {#if history.length === 0}
        <p class="px-5 py-3 text-[0.6875rem] text-muted-foreground">
          Queries you run appear here for the rest of the session.
        </p>
      {:else}
        {#each history as run, index (run.id)}
          <button
            type="button"
            class="grid h-7.5 w-full cursor-pointer grid-cols-[1fr_4.75rem_3.625rem_3.375rem] items-center gap-3 px-5 text-left transition-colors hover:bg-muted"
            style="box-shadow:{index ? 'inset 0 0.5px 0 var(--hairline)' : 'none'}"
            onclick={() => onHistory(run)}
          >
            <span class="truncate text-[0.6875rem]">{run.text.replace(/\s+/g, " ")}</span>
            <span class="text-right text-[0.625rem] tabular-nums text-muted-foreground"
              >{formatRowCount(run.rowCount)}</span
            >
            <span class="text-right text-[0.625rem] tabular-nums text-muted-foreground"
              >{run.tookMs}ms</span
            >
            <span class="text-right text-[0.625rem] tabular-nums text-muted-foreground"
              >{formatAge(run.at, now)}</span
            >
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  {#if panel === "schema"}
    <div
      class="flex flex-wrap gap-8 px-5 py-3.5 shadow-[inset_0_0.5px_0_var(--hairline)]"
      data-sb
    >
      {#if visibleViews.length === 0}
        <p class="text-[0.6875rem] text-muted-foreground">The field registry has not loaded yet.</p>
      {/if}
      {#each visibleViews as view (view.view)}
        <div class="flex min-w-32 flex-col gap-1">
          <span class="text-[0.6875rem] font-medium" title={view.description}>{view.view}</span>
          <span class="text-[0.625rem] leading-[1.8] text-muted-foreground">
            {#each view.columns as column (column.name)}
              <span class="block truncate" title={column.description}>{column.name}</span>
            {/each}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</section>
