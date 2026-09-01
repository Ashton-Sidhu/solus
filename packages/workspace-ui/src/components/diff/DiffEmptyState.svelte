<script lang="ts">
import { FileQuestion as FileDashedIcon } from "@lucide/svelte";
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
    /** The diff pane is too narrow for two columns, so this card leads the pane
     *  rather than floating in the middle of it. Owned by the panel, which is
     *  what measures the pane. */
    stacked?: boolean;
  }

  let {
    selectedTurnIndex,
    isWorkingTreeScope,
    isWorktree,
    targetBranch,
    onClose,
    title,
    description,
    stacked = false,
  }: Props = $props();

  // A narrow pane shows one column at a time, so a centred mark leaves several
  // hundred pixels of void above and below it. The card starts at the top of the
  // pane instead, reading as a statement about the project rather than as a hole
  // in the layout. A companion pane is narrow for the same reason a phone is.
  const isPhone = $derived(stacked);
  const headline = $derived(
    title ??
      (selectedTurnIndex !== null
        ? "No files touched in this turn"
        : isWorkingTreeScope
          ? "No uncommitted changes"
          : isWorktree
            ? `No changes since ${targetBranch}`
            : "No changes yet"),
  );
  const body = $derived(
    description ??
      (selectedTurnIndex !== null
        ? "The agent didn't write or edit any files during this step."
        : isWorkingTreeScope
          ? "Staged and unstaged changes will appear here."
          : "Changes will appear here as the agent edits files."),
  );
</script>

{#if isPhone}
  <div class="flex-1 px-4 pt-4">
    <div class="flex flex-col items-start gap-2.5 rounded-2xl bg-(--card) p-[1.375rem] text-sm shadow-[shadow:var(--elev-ring)]">
      <span class="flex size-[2.125rem] items-center justify-center rounded-lg bg-(--wash-3) text-(--muted-foreground)">
        <FileDashedIcon size={17} />
      </span>
      <div class="font-semibold tracking-[-0.01em] text-(--solus-text-primary)">{headline}</div>
      <p class="leading-[1.65] text-(--muted-foreground) text-pretty">{body}</p>
      {#if onClose}
        <button
          type="button"
          class="mt-1 h-[2.125rem] cursor-pointer rounded-lg border-0 bg-transparent px-3.5 font-medium text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] [-webkit-tap-highlight-color:transparent]"
          onclick={onClose}
        >
          Close panel
        </button>
      {/if}
    </div>
  </div>
{:else}
<div class="flex-1 flex items-center justify-center px-6">
  <div class="flex flex-col items-center text-center gap-2.5 py-4">
    <span
      class="flex items-center justify-center rounded-full"
      style="width:2.5rem;height:2.5rem;background:var(--solus-empty-state-bg);color:var(--solus-accent)"
    >
      <FileDashedIcon size={20} weight="duotone" />
    </span>
    <span class="text-sm font-medium text-(--solus-text-primary)">{headline}</span>
    <span
      class="text-xs text-(--solus-text-tertiary) leading-snug max-w-[15rem]"
    >
      {body}
    </span>
    {#if onClose}
      <Button
        variant="link"
        onclick={onClose}
        class="mt-1 h-10 text-xs text-(--solus-text-tertiary) hover:text-(--solus-text-secondary)"
        title="Close diff panel (Esc)"
      >
        Close panel
      </Button>
    {/if}
  </div>
</div>
{/if}
