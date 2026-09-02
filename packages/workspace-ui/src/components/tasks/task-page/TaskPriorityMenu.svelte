<script lang="ts">
  import type { Snippet } from "svelte";
  import type { TaskPriority } from "@solus/contracts/task-types";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { PRIORITY_META, PRIORITY_OPTIONS } from "../lib/tasks-api";

  /**
   * The task's priority, as a menu, wherever the priority is shown. Same split
   * as `TaskStatusMenu`: this owns the options, the call site owns the trigger.
   *
   * "No priority" is an option rather than a clear button, because unset is a
   * priority a task can be in and reads as one in the list.
   */
  interface Props {
    priority: TaskPriority | undefined;
    disabled?: boolean;
    onSelect: (priority: TaskPriority | null) => void;
    align?: "start" | "end";
    triggerClass: string;
    trigger: Snippet;
  }
  let {
    priority,
    disabled = false,
    onSelect,
    align = "start",
    triggerClass,
    trigger,
  }: Props = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger {disabled} class={triggerClass}>
    {@render trigger()}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content {align} class="w-[182px]">
    {#each PRIORITY_OPTIONS as option (option)}
      <DropdownMenu.Item onSelect={() => onSelect(option)}>
        {PRIORITY_META[option].label}
        {#if option === priority}
          <span class="ml-auto text-primary" aria-hidden="true">✓</span>
        {/if}
      </DropdownMenu.Item>
    {/each}
    <DropdownMenu.Item onSelect={() => onSelect(null)}>
      No priority
      {#if !priority}
        <span class="ml-auto text-primary" aria-hidden="true">✓</span>
      {/if}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
