<script lang="ts">
  import { tick } from "svelte";
  import { Search as MagnifyingGlassIcon, X as XIcon } from "@lucide/svelte";
  import Kbd from "../ui/Kbd.svelte";
  import type { MetricsFieldDescriptor, MetricsSchema } from "@solus/contracts/observability-types";
  import {
    FACT_TABLE_NOTE,
    JOIN_KEY,
    advancedSources,
    enumeratedValues,
    groupedColumns,
    queryTables,
    schemaSources,
    searchColumns,
  } from "./lib/schema-model";

  /**
   * What the user is allowed to know about the data they are querying.
   *
   * Three states, one surface. The sheet opens on the choice a reader actually
   * arrives with — which of the two tables answers my question — stated as two
   * cards carrying each table's served description and the one relationship
   * between them. Picking a table lists its columns, grouped by the role they
   * play in a query. Typing searches every column of every source at once,
   * because not knowing which table holds a fact is exactly the state the
   * reader arrives in, and each hit names its own table.
   *
   * A column is a control, not a label: clicking one writes it into the SQL
   * editor and returns the reader to the query they were composing.
   */
  interface Props {
    schema: MetricsSchema | null;
    onClose: () => void;
    /** Write a column name into the SQL editor at the cursor and leave. */
    onInsertColumn: (name: string) => void;
    /** Mobile reads the model but composes nothing, so the insert affordance is
     *  absent there rather than present and inert. */
    readOnly?: boolean;
  }

  let { schema, onClose, onInsertColumn, readOnly = false }: Props = $props();

  let query = $state("");
  /** null is the overview: the table choice, not a table's columns. */
  let selectedName = $state<string | null>(null);
  let activeIndex = $state(0);
  let searchEl = $state<HTMLInputElement | null>(null);
  let paneEl = $state<HTMLDivElement | null>(null);

  const sources = $derived(schema ? schemaSources(schema) : []);
  const tables = $derived(schema ? queryTables(schema) : []);
  const advanced = $derived(schema ? advancedSources(schema) : []);

  // A host refresh that removes the selected source falls back to the overview
  // rather than blanking the pane.
  const selected = $derived(sources.find((source) => source.name === selectedName) ?? null);

  const searching = $derived(query.trim().length > 0);
  const matches = $derived(searching ? searchColumns(sources, query) : []);
  const groups = $derived(selected && !searching ? groupedColumns(selected.columns) : []);

  /** Each group's rows carry the index the keyboard walks, so browsing and
   *  searching move through one list rather than two. */
  const browseGroups = $derived.by(() => {
    let index = 0;
    return groups.map((group) => ({
      label: group.label,
      hint: group.hint,
      rows: group.columns.map((column) => ({ index: index++, column })),
    }));
  });
  const rowCount = $derived(searching ? matches.length : (selected?.columns.length ?? 0));

  /** How many of a source's columns the current search matches — a nav row
   *  states this, so the answer's table is visible from the navigation. */
  function matchesIn(sourceName: string): number {
    return matches.filter((match) => match.source === sourceName).length;
  }

  function insert(name: string): void {
    if (readOnly) return;
    onInsertColumn(name);
  }

  function select(name: string | null): void {
    selectedName = name;
    query = "";
    activeIndex = 0;
    searchEl?.focus();
  }

  // Opening lands on the search field: the fastest path through the model is
  // typing the fact you are after, not clicking down to it. The sheet is
  // mounted only while open, so this runs once per opening.
  $effect(() => {
    void tick().then(() => searchEl?.focus());
  });

  // A typed character re-ranks the list under the cursor; keeping the old index
  // would leave the highlight on an unrelated row.
  $effect(() => {
    void query;
    void selectedName;
    activeIndex = 0;
  });

  $effect(() => {
    void activeIndex;
    if (!paneEl) return;
    void tick().then(() => {
      paneEl?.querySelector("[data-active='true']")?.scrollIntoView({ block: "nearest" });
    });
  });

  function activeColumnName(): string | null {
    if (searching) return matches[activeIndex]?.column.name ?? null;
    for (const group of browseGroups) {
      const row = group.rows.find((entry) => entry.index === activeIndex);
      if (row) return row.column.name;
    }
    return null;
  }

  // Esc is not handled here: the page's `insights.close` binding walks the
  // surfaces back one at a time and closes this sheet first, so one key means
  // one step out no matter where the focus sits.
  function onKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rowCount === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      activeIndex = (activeIndex + delta + rowCount) % rowCount;
      return;
    }
    if (event.key === "Enter") {
      const name = activeColumnName();
      if (!name) return;
      event.preventDefault();
      insert(name);
    }
  }
</script>

{#snippet navRow(label: string, count: string, isSelected: boolean, onSelect: () => void)}
  <button
    type="button"
    aria-current={isSelected}
    class="flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[length:calc(.8125rem*var(--solus-font-scale,1))] transition-colors {isSelected
      ? 'bg-[var(--wash-2)] font-medium text-foreground'
      : 'text-muted-foreground hover:bg-[var(--wash-1)] hover:text-foreground'}"
    onclick={onSelect}
  >
    <span class="min-w-0 flex-1 truncate">{label}</span>
    <span
      class="shrink-0 text-[length:calc(.75rem*var(--solus-font-scale,1))] tabular-nums text-muted-foreground"
      >{count}</span
    >
  </button>
{/snippet}

{#snippet columnRow(column: MetricsFieldDescriptor, index: number, sourceName: string | null)}
  {@const enumerated = enumeratedValues(column.description)}
  <svelte:element
    this={readOnly ? "div" : "button"}
    role={readOnly ? "listitem" : "option"}
    aria-selected={readOnly ? undefined : index === activeIndex}
    type={readOnly ? undefined : "button"}
    data-active={index === activeIndex}
    class="grid w-full grid-cols-[minmax(0,11rem)_3.5rem_minmax(0,1fr)] items-baseline gap-x-4 rounded-lg px-3 py-1.5 text-left transition-colors @3xl:grid-cols-[minmax(0,14rem)_4.5rem_minmax(0,1fr)] @3xl:gap-x-6 {readOnly
      ? ''
      : 'cursor-pointer hover:bg-[var(--wash-1)]'} {index === activeIndex && !readOnly
      ? 'bg-[var(--wash-2)]'
      : ''}"
    onclick={() => insert(column.name)}
    onmouseenter={() => {
      if (!readOnly) activeIndex = index;
    }}
  >
    <span class="flex min-w-0 items-baseline gap-1.5">
      {#if sourceName}
        <span
          class="shrink-0 text-[length:calc(.75rem*var(--solus-font-scale,1))] text-muted-foreground opacity-70"
          >{sourceName}</span
        >
      {/if}
      <span
        class="min-w-0 truncate text-[length:calc(.8125rem*var(--solus-font-scale,1))] font-medium text-foreground"
        >{column.name}</span
      >
    </span>
    <span
      class="truncate text-[length:calc(.75rem*var(--solus-font-scale,1))] text-muted-foreground opacity-70"
      >{column.type}</span
    >
    <!-- An enumerating description reads as its values, not as a paragraph of
         them: the lead clause, then the values themselves. A value the registry
         glosses states its gloss beside it — the meaning is the reason the
         value is listed, so it is read, not hovered for. Values with no gloss
         are one quiet run, because a list of bare names needs no rows. -->
    <span
      class="flex min-w-0 flex-col gap-1 text-[length:calc(.75rem*var(--solus-font-scale,1))] leading-relaxed text-muted-foreground"
    >
      <span>{enumerated ? enumerated.lead : column.description}</span>
      {#if enumerated && enumerated.values.some((entry) => entry.gloss)}
        <span class="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 leading-snug">
          {#each enumerated.values as entry (entry.value)}
            <span class="text-foreground">{entry.value}</span>
            <span class="min-w-0 opacity-80">{entry.gloss}</span>
          {/each}
        </span>
      {:else if enumerated}
        <span class="min-w-0 text-foreground">
          {enumerated.values.map((entry) => entry.value).join(" · ")}
        </span>
      {/if}
    </span>
  </svelte:element>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-[10020] flex items-start justify-center bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] px-4 pt-[7vh] sm:pt-[6vh] motion-safe:animate-[backdrop-fade_140ms_ease-out]"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
  onkeydown={onKey}
>
  <div
    class="schema-sheet-enter flex h-[min(82vh,52rem)] w-[clamp(20rem,94vw,72rem)] origin-top flex-col overflow-hidden rounded-2xl bg-card shadow-[0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.34)] outline-none"
    role="dialog"
    aria-modal="true"
    aria-label="Schema"
  >
    <header
      class="flex h-12 shrink-0 items-center gap-3 pr-2.5 pl-4 shadow-[inset_0_-0.5px_0_var(--hairline)]"
    >
      <h2
        class="shrink-0 text-[length:calc(.8125rem*var(--solus-font-scale,1))] font-medium text-foreground"
      >
        Schema
      </h2>
      <div
        class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-[var(--wash-1)] px-2.5 shadow-[inset_0_0_0_0.5px_var(--hairline)] transition-shadow focus-within:shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--primary)_40%,transparent)]"
      >
        <MagnifyingGlassIcon size={13} class="shrink-0 text-muted-foreground opacity-70" />
        <input
          bind:this={searchEl}
          bind:value={query}
          class="min-w-0 flex-1 bg-transparent text-[length:calc(.8125rem*var(--solus-font-scale,1))] outline-none placeholder:text-muted-foreground"
          placeholder="Search columns"
          aria-label="Search columns"
        />
        {#if searching}
          <span
            class="shrink-0 text-[length:calc(.75rem*var(--solus-font-scale,1))] tabular-nums text-muted-foreground"
            >{matches.length}</span
          >
        {/if}
      </div>
      <button
        type="button"
        class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--wash-1)] hover:text-foreground"
        onclick={onClose}
        aria-label="Close schema"
      >
        <XIcon size={14} />
      </button>
    </header>

    {#if !schema}
      <p
        class="px-4 py-4 text-[length:calc(.8125rem*var(--solus-font-scale,1))] text-muted-foreground"
      >
        The field registry has not loaded yet.
      </p>
    {:else}
      <div class="flex min-h-0 flex-1 flex-col md:flex-row">
        <!-- Navigation. The two query tables lead; the sources a reader is not
             choosing between sit under their own heading. -->
        <nav
          class="flex shrink-0 gap-1 overflow-x-auto px-2 py-2 shadow-[inset_0_-0.5px_0_var(--hairline)] md:w-52 md:flex-col md:overflow-x-visible lg:w-60 md:overflow-y-auto md:px-2 md:py-2.5 md:shadow-[inset_-0.5px_0_0_var(--hairline)]"
          style="background:var(--wash-1)"
          data-sb
          aria-label="Tables"
        >
          <div class="w-28 shrink-0 md:w-auto">
            {@render navRow("Overview", "", !searching && !selected, () => select(null))}
          </div>
          {#each tables as table (table.name)}
            <div class="w-36 shrink-0 md:w-auto">
              {@render navRow(
                table.name,
                searching ? `${matchesIn(table.name)}/${table.columns.length}` : `${table.columns.length}`,
                !searching && selected?.name === table.name,
                () => select(table.name),
              )}
            </div>
          {/each}
          <div class="hidden md:mt-4 md:mb-0.5 md:block md:px-2">
            <span
              class="text-[length:calc(.75rem*var(--solus-font-scale,1))] text-muted-foreground uppercase opacity-70"
              >Advanced</span
            >
          </div>
          {#each advanced as source (source.name)}
            <div class="w-36 shrink-0 md:w-auto">
              {@render navRow(
                source.name,
                searching ? `${matchesIn(source.name)}/${source.columns.length}` : `${source.columns.length}`,
                !searching && selected?.name === source.name,
                () => select(source.name),
              )}
            </div>
          {/each}
        </nav>

        <!-- The pane: the table choice, one table's columns, or the search. -->
        <div
          bind:this={paneEl}
          class="@container min-h-0 min-w-0 flex-1 overflow-y-auto"
          data-sb
          role={searching || selected ? "listbox" : "region"}
          aria-label={searching || selected ? "Columns" : "Tables"}
          tabindex="-1"
        >
          {#if searching}
            <div class="px-3 py-3">
              {#if matches.length === 0}
                <p
                  class="px-3 py-6 text-[length:calc(.8125rem*var(--solus-font-scale,1))] text-muted-foreground"
                >
                  No column matches “{query.trim()}”.
                </p>
              {:else}
                {#each matches as match, index (match.source + match.column.name)}
                  {@render columnRow(match.column, index, match.source)}
                {/each}
              {/if}
            </div>
          {:else if selected}
            <!-- What this table is, before what it holds: the description is
                 the answer to "should I be querying this one at all". -->
            <div
              class="sticky top-0 z-10 bg-card px-6 pt-5 pb-3.5 shadow-[inset_0_-0.5px_0_var(--hairline)]"
            >
              <h3
                class="text-[length:calc(.8125rem*var(--solus-font-scale,1))] font-medium text-foreground"
              >
                {selected.name}
              </h3>
              <p
                class="mt-1 max-w-[74ch] text-[length:calc(.75rem*var(--solus-font-scale,1))] leading-relaxed text-muted-foreground"
              >
                {selected.description}{#if selected.role === "fact"}
                  — {FACT_TABLE_NOTE}.{/if}
              </p>
            </div>
            <div class="px-3 pt-1 pb-5">
              {#each browseGroups as group (group.label || "all")}
                {#if group.label}
                  <div class="mt-5 mb-1 flex items-center gap-2.5 px-3 first:mt-2">
                    <h4
                      class="text-[length:calc(.75rem*var(--solus-font-scale,1))] font-medium text-muted-foreground uppercase"
                    >
                      {group.label}
                    </h4>
                    {#if group.hint}
                      <span
                        class="text-[length:calc(.75rem*var(--solus-font-scale,1))] text-muted-foreground opacity-60"
                        >{group.hint}</span
                      >
                    {/if}
                    <span class="h-px flex-1 bg-[var(--hairline)]"></span>
                  </div>
                {/if}
                {#each group.rows as row (row.column.name)}
                  {@render columnRow(row.column, row.index, null)}
                {/each}
              {/each}
            </div>
          {:else}
            <!-- The overview: the choice, stated once. -->
            <div class="px-6 py-6">
              <h3
                class="text-[length:calc(.8125rem*var(--solus-font-scale,1))] font-medium text-foreground"
              >
                Which table?
              </h3>

              <div class="mt-3 grid gap-2.5 @2xl:grid-cols-2">
                {#each tables as table (table.name)}
                  <button
                    type="button"
                    class="cursor-pointer rounded-xl bg-card p-3.5 text-left shadow-[shadow:var(--elev-ring)] transition-shadow hover:shadow-[shadow:0_0_0_0.5px_var(--hairline-strongest),0_0.25rem_0.75rem_-0.375rem_rgba(0,0,0,0.1)]"
                    onclick={() => select(table.name)}
                  >
                    <span class="flex items-baseline gap-2">
                      <span
                        class="text-[length:calc(.8125rem*var(--solus-font-scale,1))] font-medium text-foreground"
                        >{table.name}</span
                      >
                      <span
                        class="ml-auto text-[length:calc(.75rem*var(--solus-font-scale,1))] tabular-nums text-muted-foreground"
                        >{table.columns.length} columns</span
                      >
                    </span>
                    <span
                      class="mt-1.5 block text-[length:calc(.75rem*var(--solus-font-scale,1))] leading-relaxed text-muted-foreground"
                      >{table.description}</span
                    >
                  </button>
                {/each}
              </div>

              {#if tables.length > 1}
                <div
                  class="mt-2.5 flex items-center gap-2.5 rounded-lg px-3.5 py-2 text-[length:calc(.75rem*var(--solus-font-scale,1))]"
                  style="background:var(--wash-1)"
                >
                  <span class="text-foreground">{JOIN_KEY}</span>
                  <span class="h-px flex-1 bg-[var(--hairline-strong)]"></span>
                  <span class="text-muted-foreground"
                    >one {tables[0].name}, many {tables[1].name}</span
                  >
                </div>
              {/if}
            </div>
          {/if}
        </div>
      </div>

      <footer
        class="flex h-9 shrink-0 items-center gap-4 px-4 text-[length:calc(.75rem*var(--solus-font-scale,1))] text-muted-foreground shadow-[inset_0_0.5px_0_var(--hairline)]"
        style="background:var(--wash-1)"
      >
        {#if readOnly}
          <span>Reference only — queries are composed on desktop.</span>
        {:else}
          <span class="inline-flex items-center gap-1.5">
            <Kbd variant="keycap">↑</Kbd>
            <Kbd variant="keycap">↓</Kbd>
            move
          </span>
          <span class="inline-flex items-center gap-1.5">
            <Kbd variant="keycap">↵</Kbd>
            insert
          </span>
          <span class="inline-flex items-center gap-1.5">
            <Kbd variant="keycap">esc</Kbd>
            close
          </span>
        {/if}
      </footer>
    {/if}
  </div>
</div>

<style>
  /* Keyframes cannot be expressed as Tailwind utilities; referenced by the
     class on the panel above. */
  .schema-sheet-enter {
    /* `backwards`, not `both`: a retained end transform keeps the sheet on its
       own compositing layer and blurs its text. */
    animation: schema-sheet-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  }

  @media (prefers-reduced-motion: reduce) {
    .schema-sheet-enter {
      animation: none;
    }
  }

  @keyframes schema-sheet-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.5rem, 0) scale(0.99);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
