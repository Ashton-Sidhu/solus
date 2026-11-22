<script lang="ts">
  /**
   * The question before a change that cannot be undone from Solus, beside the
   * menu button that asked for it: Remove from Solus, or Delete from a tool's
   * config file (docs/plans/mcp-first-class.md §8.8). Focus starts on the
   * action, so Enter confirms and Escape cancels.
   */
  import { Button } from "../ui/button";
  import * as Popover from "../ui/popover";

  interface Props {
    open: boolean;
    anchor: HTMLElement | null;
    title: string;
    text: string;
    action: string;
    busyAction: string;
    isBusy: boolean;
    error: string;
    onConfirm: () => void;
  }
  let { open = $bindable(), anchor, title, text, action, busyAction, isBusy, error, onConfirm }: Props = $props();
  let actionEl = $state<HTMLElement | null>(null);
</script>

<Popover.Root bind:open>
  <Popover.Content customAnchor={anchor} side="bottom" align="end" sideOffset={6} collisionPadding={8}
    class="w-[min(18rem,calc(100vw-2rem))] gap-3 p-3.5 text-workspace-chrome lg:text-workspace-chrome" aria-label={title}
    onOpenAutoFocus={(event) => { event.preventDefault(); actionEl?.focus(); }}>
    <div class="flex flex-col gap-1">
      <p class="font-medium text-foreground">{title}</p>
      <p class="text-pretty text-(--solus-text-secondary)">{text}</p>
    </div>
    {#if error}<p role="alert" class="break-words text-(--solus-status-error)">{error}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={() => { open = false; }} disabled={isBusy}>Cancel</Button>
      <Button bind:ref={actionEl} variant="destructive" size="sm" class="text-workspace-chrome pointer-coarse:min-h-11" onclick={onConfirm} disabled={isBusy}>{isBusy ? busyAction : action}</Button>
    </div>
  </Popover.Content>
</Popover.Root>
