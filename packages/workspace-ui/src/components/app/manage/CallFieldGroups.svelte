<script lang="ts">
  import { Columns3 as ColumnIcon, Copy as CopyIcon, ZoomIn as FilterForIcon, ZoomOut as FilterOutIcon } from "@lucide/svelte";
  import type { AppCallTerm } from "@solus/contracts/apps";
  import { copyText, toasts } from "../../../lib/toasts";
  import type { CallFieldName } from "./lib/activity";
  import type { CallSheetFieldGroup } from "./lib/call-sheet";

  /**
   * The fields of a call in the call sheet, in groups. Every row reads the
   * same; a row under the pointer or the keyboard shows its actions: filter
   * for, filter out, show as a column, and copy. An action the field cannot
   * do is absent, not disabled.
   */
  interface Props {
    groups: CallSheetFieldGroup[];
    columns?: readonly CallFieldName[];
    onFilter?: (term: AppCallTerm) => void;
    onToggleColumn?: (field: CallFieldName) => void;
  }
  let { groups, columns = [], onFilter, onToggleColumn }: Props = $props();

  async function copy(value: string) {
    if (!(await copyText(value))) toasts.error("The value was not copied");
  }
</script>

<div class="flex min-w-0 flex-col px-4" data-testid="app-call-fields-list">
  {#each groups as group, index (group.label)}
    <h4 class="m-0 px-2 pb-1 text-xs font-normal text-(--solus-text-tertiary) {index === 0 ? 'pt-2' : 'pt-3.5'}">{group.label}</h4>
    <dl class="m-0 flex min-w-0 flex-col" aria-label={group.label}>
      {#each group.fields as field (field.key)}
        {@const term = field.term}
        {@const column = field.column}
        <div class="group/field flex min-h-7.5 min-w-0 items-center gap-3 rounded-[7px] px-2 hover:bg-[var(--wash-1)] focus-within:bg-[var(--wash-1)]">
          <dt class="w-37.5 shrink-0 truncate font-mono text-xs text-(--solus-text-secondary)" title={field.key}>{field.key}</dt>
          <dd class="m-0 min-w-0 flex-1 truncate py-1.5 text-foreground select-text {field.mono ? 'font-mono text-xs' : 'text-[13px]'}" title={field.value}>{field.value}</dd>
          <div class="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/field:opacity-100 group-focus-within/field:opacity-100 pointer-coarse:opacity-100">
            {#if term && onFilter}
              <button type="button" class="flex h-5.5 w-6 cursor-pointer items-center justify-center rounded text-(--solus-text-secondary) outline-none hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)]" title="Filter for this value" aria-label="Filter for {field.key} {field.value}" onclick={() => onFilter(term)}>
                <FilterForIcon size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" class="flex h-5.5 w-6 cursor-pointer items-center justify-center rounded text-(--solus-text-secondary) outline-none hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)]" title="Filter out this value" aria-label="Filter out {field.key} {field.value}" onclick={() => onFilter({ ...term, not: true })}>
                <FilterOutIcon size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            {/if}
            {#if column && onToggleColumn}
              {@const isColumn = columns.includes(column)}
              <button type="button" class="flex h-5.5 w-6 cursor-pointer items-center justify-center rounded outline-none hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)] {isColumn ? 'text-foreground' : 'text-(--solus-text-secondary)'}" title={isColumn ? "Take out of the columns" : "Show as a column"} aria-label={isColumn ? `Take ${field.key} out of the columns` : `Show ${field.key} as a column`} aria-pressed={isColumn} onclick={() => onToggleColumn(column)}>
                <ColumnIcon size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            {/if}
            <button type="button" class="flex h-5.5 w-6 cursor-pointer items-center justify-center rounded text-(--solus-text-secondary) outline-none hover:bg-[var(--wash-3)] hover:text-foreground focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent)]" title="Copy the value" aria-label="Copy {field.key}" onclick={() => void copy(field.copyValue)}>
              <CopyIcon size={13} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>
      {/each}
    </dl>
  {:else}
    <p class="m-0 px-2 py-2 text-[13px] text-(--solus-text-tertiary)">No field holds this text.</p>
  {/each}
</div>
