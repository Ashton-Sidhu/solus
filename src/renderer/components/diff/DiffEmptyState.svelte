<script lang="ts">
  import { FileDashedIcon } from "phosphor-svelte";
  import { Button } from "../ui/button";

  interface Props {
    selectedTurnIndex: number | null;
    isWorkingTreeScope: boolean;
    isWorktree: boolean;
    targetBranch: string;
    /** Absent when the panel is embedded in a host surface that owns closing. */
    onClose?: () => void;
    title?: string;
    description?: string;
  }

  let {
    selectedTurnIndex,
    isWorkingTreeScope,
    isWorktree,
    targetBranch,
    onClose,
    title,
    description,
  }: Props = $props();
</script>

<div class="flex-1 flex items-center justify-center px-6">
  <div class="flex flex-col items-center text-center gap-2.5 py-4">
    <span
      class="flex items-center justify-center rounded-full"
      style="width:2.5rem;height:2.5rem;background:var(--solus-empty-state-bg);color:var(--solus-accent)"
    >
      <FileDashedIcon size={20} weight="duotone" />
    </span>
    <span class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
      {title ?? (selectedTurnIndex !== null
        ? "No files touched in this turn"
        : isWorkingTreeScope
          ? "No uncommitted changes"
        : isWorktree
          ? `No changes since ${targetBranch}`
          : "No changes yet")}
    </span>
    <span
      class="text-[0.6875rem] text-(--solus-text-tertiary) leading-snug max-w-[15rem]"
    >
      {description ?? (selectedTurnIndex !== null
        ? "The agent didn't write or edit any files during this step."
        : isWorkingTreeScope
          ? "Staged and unstaged changes will appear here."
          : "Changes will appear here as the agent edits files.")}
    </span>
    {#if onClose}
      <Button
        variant="link"
        onclick={onClose}
        class="mt-1 h-10 text-[0.6875rem] text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"
        title="Close diff panel (Esc)"
      >
        Close panel
      </Button>
    {/if}
  </div>
</div>
