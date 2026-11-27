<script lang="ts">
  import { Braces as JsonIcon, Rows3 as AroundIcon, Search as SearchIcon, Sheet as FieldsIcon, Waypoints as TraceIcon } from "@lucide/svelte";
  import { CALL_SHEET_TAB_LABELS, type CallSheetTab } from "./lib/call-sheet";

  /**
   * The tabs of the call sheet, as type: the open tab in ink at weight 600,
   * the others tertiary. No pill and no underline. On Fields, "Find a field"
   * narrows the rows.
   */
  interface Props {
    tabs: readonly CallSheetTab[];
    tab: CallSheetTab;
    findText: string;
    onTab: (tab: CallSheetTab) => void;
    onFind: (text: string) => void;
  }
  let { tabs, tab, findText, onTab, onFind }: Props = $props();

  const ICONS = { fields: FieldsIcon, json: JsonIcon, trace: TraceIcon, around: AroundIcon } satisfies { [Tab in CallSheetTab]: typeof FieldsIcon };

  function onKey(event: KeyboardEvent) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    onTab(next);
    document.getElementById(`call-sheet-tab-${next}`)?.focus();
  }
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-5.5 gap-y-2 px-6 pt-5.5 pb-2.5">
  <div class="flex min-w-0 flex-wrap items-center gap-x-5.5 gap-y-1" role="tablist" aria-label="Views of the call">
    {#each tabs as entry (entry)}
      {@const Icon = ICONS[entry]}
      {@const isOn = entry === tab}
      <button
        id="call-sheet-tab-{entry}"
        type="button"
        role="tab"
        aria-selected={isOn}
        tabindex={isOn ? 0 : -1}
        class="flex h-7 shrink-0 cursor-pointer items-center gap-1.75 rounded-md text-sm whitespace-nowrap outline-none transition-colors focus-visible:shadow-[0_0_0_2px_color-mix(in_oklch,var(--primary)_30%,transparent)] {isOn
          ? 'font-semibold text-foreground'
          : 'text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)'}"
        onclick={() => onTab(entry)}
        onkeydown={onKey}
      >
        <Icon size={15} strokeWidth={1.75} aria-hidden="true" />{CALL_SHEET_TAB_LABELS[entry]}
      </button>
    {/each}
  </div>
  <span class="flex-1"></span>
  {#if tab === "fields"}
    <label class="flex h-6.5 w-36 min-w-0 items-center gap-1.75 rounded-[7px] px-2.25 shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] focus-within:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]">
      <SearchIcon size={12} class="shrink-0 text-(--solus-text-tertiary)" aria-hidden="true" />
      <input
        class="w-full min-w-0 border-0 bg-transparent text-[12.5px] text-foreground caret-[var(--primary)] outline-none placeholder:text-(--solus-text-tertiary)"
        placeholder="Find a field"
        aria-label="Find a field"
        value={findText}
        oninput={(event) => onFind(event.currentTarget.value)}
      />
    </label>
  {/if}
</div>
