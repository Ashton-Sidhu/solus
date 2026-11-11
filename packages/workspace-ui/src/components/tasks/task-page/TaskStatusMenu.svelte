<script lang="ts">
  import type { Snippet } from "svelte";
  import type { TaskMoveTarget } from "@solus/contracts/task-types";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { CATEGORY_META } from "../lib/tasks-api";
  import { statusTextColor } from "./lib/task-page";
  import type { TaskMoveGroup } from "./lib/task-move";

  /**
   * The task's status, as a move menu, wherever the status is shown.
   *
   * The option list is the shared part: for each source that lists the task,
   * that source's columns, or the three status categories when no source has
   * columns. The trigger is not shared: the sidebar draws a labelled row and
   * the masthead draws an inline chip, so the call site passes that in and
   * this owns the menu.
   */
  interface Props {
    /** `taskMoveGroups` of the task. */
    groups: TaskMoveGroup[];
    onSelect: (target: TaskMoveTarget) => void;
    align?: "start" | "end";
    triggerClass: string;
    trigger: Snippet;
  }
  let {
    groups,
    onSelect,
    align = "start",
    triggerClass,
    trigger,
  }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger class={triggerClass} title="Move the task">
    {@render trigger()}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content {align} class="max-h-[min(24rem,var(--bits-dropdown-menu-content-available-height))] w-[min(14rem,calc(100vw-2rem))] overflow-y-auto">
    {#each groups as group, index (group.id)}
      {#if index > 0}
        <DropdownMenu.Separator />
      {/if}
      <DropdownMenu.Group>
        {#if group.label}
          <DropdownMenu.GroupHeading class="truncate">{group.label}</DropdownMenu.GroupHeading>
        {/if}
        {#each group.options as option (option.id)}
          <!-- The task is in the current place already: there is no move to send. -->
          <DropdownMenu.Item onSelect={() => { if (!option.current) onSelect(option.target); }}>
            <svg
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              stroke-width="0.875"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="shrink-0"
              style="color:{statusTextColor(option.category)}"
              aria-hidden="true"><path d={CATEGORY_META[option.category].glyph} /></svg
            >
            <span class="min-w-0 flex-1 truncate">{option.label}</span>
            {#if option.current}
              <span class="ml-auto text-primary" aria-hidden="true">✓</span>
              <span class="sr-only">Current</span>
            {/if}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Group>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
