<script lang="ts">
  import { Minus as RemoveColumnIcon, Plus as AddColumnIcon, Search as SearchIcon, ZoomIn as FilterForIcon, ZoomOut as FilterOutIcon } from "@lucide/svelte";
  import type { AppCallTerm, AppCallView } from "@solus/contracts/apps";
  import { CALL_FIELDS, fieldValues, shareText, type CallField, type CallFieldName } from "./lib/activity";

  /**
   * The Fields list of the Activity section (docs/plans/apps.md §9.2), as a
   * log explorer has it: the fields the rows show as columns, then the
   * fields available. A field opens its most common values in the calls in
   * view, each with its share; a value filters the log for itself or out of
   * it. The button at the end of a field adds it to the columns or takes it out.
   */
  interface Props {
    calls: readonly AppCallView[];
    columns: readonly CallFieldName[];
    onFilter: (term: AppCallTerm) => void;
    onToggleColumn: (field: CallFieldName) => void;
  }
  let { calls, columns, onFilter, onToggleColumn }: Props = $props();

  let openField = $state<CallFieldName | null>(null);
  let search = $state("");
  const shown = $derived(CALL_FIELDS.filter((field) => field.name.includes(search.trim().toLowerCase())));
  const inColumns = $derived(columns.flatMap((column) => shown.filter((field) => field.name === column)));
  const available = $derived(shown.filter((field) => !columns.includes(field.name)));
</script>

{#snippet fieldRow(field: CallField, isColumn: boolean)}
  {@const isOpen = openField === field.name}
  <li class="flex min-w-0 flex-col {isOpen ? 'gap-1.5 rounded-md bg-[var(--wash-2)] pb-2.5' : ''}">
    <div class="group/field flex h-7 min-w-0 items-center rounded-sm">
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-sm px-1.5 text-left outline-none focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
        aria-expanded={isOpen}
        onclick={() => (openField = isOpen ? null : field.name)}
      >
        <span class="flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-[var(--wash-3)] font-mono text-[9.5px] leading-2.5 text-(--solus-text-tertiary)" title={field.type === "number" ? "A number" : "Text"}>{field.type === "number" ? "#" : "t"}</span>
        <span class="truncate font-mono text-xs {isColumn || isOpen ? 'text-foreground' : 'text-(--solus-text-secondary)'}">{field.name}</span>
      </button>
      <button
        type="button"
        class="mr-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) opacity-0 outline-none transition-opacity group-hover/field:opacity-100 hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:opacity-100 focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] pointer-coarse:opacity-100"
        aria-label={isColumn ? `Take ${field.name} out of the columns` : `Show ${field.name} as a column`}
        title={isColumn ? "Take out of the columns" : "Show as a column"}
        onclick={() => onToggleColumn(field.name)}
      >
        {#if isColumn}<RemoveColumnIcon size={13} aria-hidden="true" />{:else}<AddColumnIcon size={13} aria-hidden="true" />{/if}
      </button>
    </div>
    {#if isOpen}
      {@const values = fieldValues(calls, field.name)}
      {#if values.length === 0}
        <p class="m-0 px-1.5 text-[11px] text-(--solus-text-tertiary)">No call in view holds a {field.name}.</p>
      {:else}
        <p class="m-0 px-1.5 text-[11px] leading-3.5 text-(--solus-text-tertiary)">Top values in {calls.length.toLocaleString()} {calls.length === 1 ? "call" : "calls"}</p>
        <ul class="m-0 flex list-none flex-col gap-1.5 p-0 px-1.5" aria-label="Values of {field.name}">
          {#each values as entry (entry.value)}
            {@const queryField = field.queryField}
            <li class="flex min-w-0 flex-col gap-0.75">
              <div class="flex min-w-0 items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground" title={entry.value}>{entry.value}</span>
                <span class="shrink-0 font-mono text-[11px] text-(--solus-text-tertiary)">{shareText(entry.share)}</span>
                {#if queryField}
                  <button
                    type="button"
                    class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-(--solus-text-tertiary) outline-none hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
                    aria-label="Filter for {field.name} {entry.value}"
                    title="Filter for this value"
                    onclick={() => onFilter({ field: queryField, value: entry.value })}
                  >
                    <FilterForIcon size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-(--solus-text-tertiary) outline-none hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
                    aria-label="Filter out {field.name} {entry.value}"
                    title="Filter out this value"
                    onclick={() => onFilter({ field: queryField, value: entry.value, not: true })}
                  >
                    <FilterOutIcon size={13} aria-hidden="true" />
                  </button>
                {/if}
              </div>
              <span class="h-0.75 w-full overflow-hidden rounded-[2px] bg-[var(--wash-3)]" aria-hidden="true">
                <span class="block h-full rounded-[2px] bg-[color-mix(in_oklch,var(--foreground)_40%,transparent)]" style="width:{entry.share * 100}%"></span>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </li>
{/snippet}

<nav class="flex min-w-0 flex-col gap-0.5" aria-label="Fields" data-testid="app-call-fields">
  <label class="mb-2 flex h-7 min-w-0 shrink-0 items-center gap-2 rounded-md px-2.25 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]">
    <SearchIcon size={13} class="shrink-0 text-muted-foreground opacity-70" aria-hidden="true" />
    <input
      class="w-full min-w-0 border-0 bg-transparent text-[13px] text-foreground caret-[var(--primary)] outline-none placeholder:text-(--solus-text-tertiary)"
      placeholder="Search fields"
      aria-label="Search fields"
      bind:value={search}
    />
  </label>
  {#if inColumns.length > 0}
    <h4 class="m-0 px-1.5 py-1 text-xs font-normal text-(--solus-text-tertiary)">Columns</h4>
    <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
      {#each inColumns as field (field.name)}
        {@render fieldRow(field, true)}
      {/each}
    </ul>
  {/if}
  {#if available.length > 0}
    <h4 class="m-0 px-1.5 pt-3 pb-1 text-xs font-normal text-(--solus-text-tertiary)">
      Available fields <span class="font-mono text-[11px]">{available.length}</span>
    </h4>
    <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
      {#each available as field (field.name)}
        {@render fieldRow(field, false)}
      {/each}
    </ul>
  {/if}
  {#if shown.length === 0}
    <p class="m-0 px-1.5 py-1 text-xs text-(--solus-text-tertiary)">No field is named so.</p>
  {/if}
</nav>
