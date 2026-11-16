<script lang="ts">
  import type { AppCallTerm, AppCallView } from "@solus/contracts/apps";
  import { CALL_FIELDS, fieldValues, shareText, type CallColumn, type CallField } from "./lib/activity";

  /**
   * The Fields list of the Activity section (docs/plans/apps.md §9.2): the
   * fields in the table, then the others. A field opens its most common
   * values in the calls in view, each with its share; a value adds a filter.
   */
  interface Props {
    calls: readonly AppCallView[];
    columns: readonly CallColumn[];
    onFilter: (term: AppCallTerm) => void;
  }
  let { calls, columns, onFilter }: Props = $props();

  let openField = $state<string | null>(null);
  const inTable = $derived(CALL_FIELDS.filter((field) => columns.some((column) => column === field.name)));
  const others = $derived(CALL_FIELDS.filter((field) => !columns.some((column) => column === field.name)));
</script>

{#snippet fieldRow(field: CallField)}
  {@const isOpen = openField === field.name}
  <li class="flex min-w-0 flex-col {isOpen ? 'rounded-xl bg-[var(--wash-2)] pb-2' : ''}">
    <button
      type="button"
      class="flex h-8 w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-lg px-2 text-left text-sm text-foreground transition-colors duration-150 hover:bg-[var(--wash-2)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none {isOpen ? 'font-medium' : ''}"
      aria-expanded={isOpen}
      onclick={() => (openField = isOpen ? null : field.name)}
    >
      <span class="w-3 shrink-0 text-center text-xs text-muted-foreground" title={field.type === "number" ? "A number" : "Text"}>{field.type === "number" ? "#" : "t"}</span>
      <span class="truncate">{field.name}</span>
    </button>
    {#if isOpen}
      {@const values = fieldValues(calls, field.name)}
      {#if values.length === 0}
        <p class="m-0 px-2 pt-1 text-xs text-muted-foreground">No call in view holds a {field.name}.</p>
      {:else}
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0 px-1" aria-label="Values of {field.name}">
          {#each values as entry (entry.value)}
            {@const queryField = field.queryField}
            <li>
              <button
                type="button"
                class="flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded-md px-1 py-1 text-left text-[13px] enabled:hover:bg-[var(--wash-2)] focus-visible:bg-[var(--wash-2)] focus-visible:outline-none disabled:cursor-default"
                disabled={!queryField}
                title={queryField ? `Show only calls where ${field.name} is ${entry.value}` : undefined}
                onclick={() => queryField && onFilter({ field: queryField, value: entry.value })}
              >
                <span class="flex min-w-0 items-baseline justify-between gap-2">
                  <span class="truncate text-foreground">{entry.value}</span>
                  <span class="shrink-0 text-xs tabular-nums text-muted-foreground">{shareText(entry.share)}</span>
                </span>
                <span class="h-1 w-full overflow-hidden rounded-full bg-[var(--wash-3)]" aria-hidden="true">
                  <span class="block h-full rounded-full {field.name === 'outcome' && entry.value === 'failed' ? 'bg-(--failure)' : 'bg-[color-mix(in_oklch,var(--foreground)_35%,transparent)]'}" style="width:{entry.share * 100}%"></span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
        <p class="m-0 px-2 pt-1 text-xs text-muted-foreground">
          {field.queryField ? `Of the ${calls.length.toLocaleString()} calls in view. Choose a value to filter.` : `Of the ${calls.length.toLocaleString()} calls in view.`}
        </p>
      {/if}
    {/if}
  </li>
{/snippet}

<nav class="flex min-w-0 flex-col gap-4" aria-label="Fields" data-testid="app-call-fields">
  <h3 class="m-0 px-2 text-sm font-medium text-foreground">Fields</h3>
  {#each [{ label: "In the table", fields: inTable }, { label: "More fields", fields: others }] as part (part.label)}
    {#if part.fields.length > 0}
      <div class="flex min-w-0 flex-col gap-1">
        <h4 class="m-0 px-2 text-xs font-normal text-muted-foreground">{part.label}</h4>
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
          {#each part.fields as field (field.name)}
            {@render fieldRow(field)}
          {/each}
        </ul>
      </div>
    {/if}
  {/each}
</nav>
