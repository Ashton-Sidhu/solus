<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    Check as CheckIcon,
    Copy as CopyIcon,
    Maximize2 as ExpandIcon,
    Minimize2 as CollapseIcon,
  } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { copyText } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { rowsToCsv, rowsToMarkdown, tableRows } from "./lib/table-copy";

  /** A reply's table scrolls sideways in its own box, so a wide table never
   *  pushes past the prose column. Expanded, the cells wrap to fit the column;
   *  collapsed, each row stays on one line and a long cell is cut short. */
  let { children }: { children?: Snippet } = $props();

  let table = $state<HTMLTableElement>();
  let expanded = $state(true);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function copyAs(format: "markdown" | "csv") {
    if (!table) return;
    const rows = tableRows(table);
    await copyText(format === "markdown" ? rowsToMarkdown(rows) : rowsToCsv(rows));
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1200);
    requestInputFocus();
  }

  function toggleExpanded() {
    expanded = !expanded;
    requestInputFocus();
  }
</script>

<div class="transcript-table group/table" data-expanded={expanded ? "true" : "false"}>
  <div class="transcript-table-scroll">
    <table bind:this={table}>{@render children?.()}</table>
  </div>
  <!-- Quiet until the table is hovered or focused; always shown on touch,
       where there is no hover. -->
  <div
    class="my-2 flex items-center justify-between opacity-0 transition-opacity duration-150 select-none group-hover/table:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
  >
    <button
      type="button"
      class="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:text-foreground pointer-coarse:size-9"
      aria-pressed={expanded}
      aria-label={expanded ? "Collapse table cells" : "Expand table cells"}
      title={expanded ? "Collapse table cells" : "Expand table cells"}
      onclick={toggleExpanded}
    >
      {#if expanded}
        <CollapseIcon class="size-3" aria-hidden="true" />
      {:else}
        <ExpandIcon class="size-3" aria-hidden="true" />
      {/if}
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-expanded:text-foreground pointer-coarse:size-9"
            aria-label={copied ? "Copied" : "Copy table"}
            title={copied ? "Copied" : "Copy table"}
          >
            {#if copied}
              <CheckIcon class="size-3" aria-hidden="true" />
            {:else}
              <CopyIcon class="size-3" aria-hidden="true" />
            {/if}
          </button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" class="min-w-40">
        <DropdownMenu.Item onSelect={() => copyAs("markdown")}>Copy as Markdown</DropdownMenu.Item>
        <DropdownMenu.Item onSelect={() => copyAs("csv")}>Copy as CSV</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</div>
