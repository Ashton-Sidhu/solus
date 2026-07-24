<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../../lib/utils";
  import InputBar from "./InputBar.svelte";
  import InputToolbar from "./InputToolbar.svelte";

  interface Props {
    class?: string;
    tabId?: string;
    onAttachFile: () => void | Promise<void>;
    onScreenshot?: (() => void | Promise<void>) | null;
    onDesignMode?: (() => void | Promise<void>) | null;
    dirMaxWidth?: number;
    trailingActions?: Snippet;
  }

  let {
    class: className,
    tabId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
    dirMaxWidth = 240,
    trailingActions,
  }: Props = $props();

  let focused = $state(false);
</script>

<div
  class={cn(
    "min-h-[5.5rem] overflow-hidden rounded-[1.375rem] border bg-(--solus-input-pill-bg) px-3.5 pt-1 pb-2 transition-[border-color,box-shadow] duration-[180ms]",
    focused
      ? "border-(--solus-input-focus-border) shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
      : "border-(--solus-container-border)",
    className,
  )}
  onfocusin={() => (focused = true)}
  onfocusout={() => (focused = false)}
>
  <InputBar mode="editor" {tabId}>
    {#snippet leadingActions()}
      <InputToolbar
        mode="editor"
        {tabId}
        {onAttachFile}
        {onScreenshot}
        {onDesignMode}
        {dirMaxWidth}
        {trailingActions}
      />
    {/snippet}
  </InputBar>
</div>
