<script lang="ts">
  /** The details of a codebase in a tooltip: its name, then one line for each
   *  folder with its host. The tooltip primitive draws its `value` as one
   *  line, so the lines here are its children, as each other tooltip with
   *  more than one fact. */
  import type { Snippet } from "svelte";
  import * as TooltipUI from "../ui/tooltip";
  import type { CodebaseTooltip } from "./lib/codebase-choice";

  let {
    details,
    side = "right",
    lead,
    hint = null,
  }: {
    details: CodebaseTooltip;
    side?: "top" | "right";
    /** A first line before the name: what the control does, with its shortcut. */
    lead?: Snippet;
    /** A last line, for example where the run works. */
    hint?: string | null;
  } = $props();
</script>

<TooltipUI.Content {side} class="max-w-72 flex-col items-start gap-0.5 py-1 text-left font-normal">
  {@render lead?.()}
  <span class="max-w-full truncate font-medium text-(--solus-text-primary)">{details.name}</span>
  {#each details.folders as folder, index (index)}
    <span class="flex max-w-full min-w-0 gap-1.5 text-(--solus-text-secondary)">
      <span class="min-w-0 truncate">{folder.name}</span>
      <span class="shrink-0 text-(--solus-text-tertiary)">{folder.host ?? "Unknown host"}</span>
    </span>
  {/each}
  {#if details.more > 0}
    <span class="text-(--solus-text-tertiary)">and {details.more} more</span>
  {/if}
  {#if hint}
    <span class="text-(--solus-text-tertiary)">{hint}</span>
  {/if}
</TooltipUI.Content>
