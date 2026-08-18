<script lang="ts">
  import { CheckIcon } from "phosphor-svelte";
  import * as Popover from "../ui/popover";
  import { menuRowVariants } from "../ui/menu/menu-row";
  import { cn } from "@renderer/lib/tw";
  import ProjectMark from "./ProjectMark.svelte";
  import type { ProjectFilterChoice } from "./lib/task-list";

  interface Props {
    /** The scoped project's key, or null for the whole list. */
    projectFilter: string | null;
    choices: ProjectFilterChoice[];
    onFilter: (projectKey: string | null) => void;
    onClose: () => void;
    /** The trigger the menu drops from. */
    anchor: HTMLElement;
  }
  let { projectFilter, choices, onFilter, onClose, anchor }: Props = $props();

  let open = $state(true);
  let rowsEl: HTMLDivElement | undefined = $state();

  /** Arrows walk the rows, the way every other menu in the app answers them. */
  function onRowsKeydown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = [...(rowsEl?.querySelectorAll("button") ?? [])];
    if (!(event.target instanceof HTMLButtonElement)) return;
    const from = event.target;
    const step = event.key === "ArrowDown" ? 1 : -1;
    rows[(rows.indexOf(from) + step + rows.length) % rows.length]?.focus();
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) onClose();
  }}
>
  <!-- Past nine projects the list scrolls rather than running the column's
       height. There is no search field: a project long enough to need one is
       found from the breadcrumb, not from a scope switch. -->
  <Popover.Content
    data-solus-ui
    customAnchor={anchor}
    side="bottom"
    align="start"
    sideOffset={6}
    collisionPadding={8}
    aria-label="Filter tasks by project"
    class="menu-surface z-[10002] max-h-80 w-[13.375rem] gap-0 overflow-y-auto rounded-2xl bg-(--solus-menu-bg) p-1.5 text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-menu"
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      rowsEl?.querySelector("button")?.focus();
    }}
  >
    <div bind:this={rowsEl} onkeydown={onRowsKeydown} role="none">
      <button
        type="button"
        class={cn(menuRowVariants(), "w-full")}
        onclick={() => onFilter(null)}
      >
        <span class="min-w-0 flex-1 truncate text-left">All projects</span>
        {#if projectFilter === null}
          <CheckIcon size={13} weight="bold" class="shrink-0 text-primary" />
        {/if}
      </button>
      {#each choices as choice (choice.projectKey)}
        <button
          type="button"
          title={choice.projectKey}
          class={cn(menuRowVariants(), "w-full")}
          onclick={() => onFilter(choice.projectKey)}
        >
          <ProjectMark
            projectKey={choice.projectKey}
            initial={choice.initial}
            active={false}
            class="size-[0.875rem]"
            letterClass="text-xs"
          />
          <span class="min-w-0 flex-1 truncate text-left">{choice.label}</span>
          <span
            class="shrink-0 text-xs tabular-nums opacity-50"
            >{choice.count}</span
          >
          {#if projectFilter === choice.projectKey}
            <CheckIcon size={13} weight="bold" class="shrink-0 text-primary" />
          {/if}
        </button>
      {/each}
    </div>
  </Popover.Content>
</Popover.Root>
