<script lang="ts">
  import type { Snippet } from "svelte";
  import type { TaskStatus } from "@solus/contracts/task-types";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { STATUS_META } from "../lib/tasks-api";
  import { statusTextColor } from "./lib/task-page";

  /**
   * The task's status, as a menu, wherever the status is shown.
   *
   * The option list is the shared part: the glyph, its status tint, and the
   * check on the current one are the same decision on every surface. The
   * trigger is not — the sidebar draws a labelled row and the masthead draws an
   * inline chip — so the call site passes that in and this owns the menu.
   */
  interface Props {
    status: TaskStatus;
    /** The statuses this task's provider will accept. Empty where the status
     *  cannot be changed from Solus at all, which disables the trigger rather
     *  than opening a menu with nothing in it. */
    options: TaskStatus[];
    onSelect: (status: TaskStatus) => void;
    align?: "start" | "end";
    triggerClass: string;
    trigger: Snippet;
  }
  let {
    status,
    options,
    onSelect,
    align = "start",
    triggerClass,
    trigger,
  }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger disabled={!options.length} class={triggerClass}>
    {@render trigger()}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content {align} class="w-[182px]">
    {#each options as option (option)}
      {@const meta = STATUS_META[option]}
      <DropdownMenu.Item onSelect={() => onSelect(option)}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.45"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0"
          style="color:{statusTextColor(option)}"
          aria-hidden="true"><path d={meta.glyph} /></svg
        >
        {meta.label}
        {#if option === status}
          <span class="ml-auto text-primary" aria-hidden="true">✓</span>
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
