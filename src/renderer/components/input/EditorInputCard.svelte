<script lang="ts">
  import type { Snippet } from "svelte";
  import { cn } from "../../lib/utils";
  import { getWorkspaceContext } from "../../contexts";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import InputBar from "./InputBar.svelte";
  import InputBarHeader from "./InputBarHeader.svelte";
  import InputToolbar from "./InputToolbar.svelte";

  interface Props {
    class?: string;
    tabId?: string;
    onAttachFile: () => void | Promise<void>;
    onScreenshot?: (() => void | Promise<void>) | null;
    onDesignMode?: (() => void | Promise<void>) | null;
    trailingActions?: Snippet;
  }

  let {
    class: className,
    tabId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
    trailingActions,
  }: Props = $props();

  const session = getWorkspaceContext();
  const started = $derived(
    hasSessionStarted(session.sessionFor(tabId ?? session.activeTabId)),
  );

  let focused = $state(false);
</script>

<div class={cn("flex flex-col", className)}>
  <!--
    Destination is only editable pre-flight, so the strip mounts for exactly
    that long. `{#if}` beats the renderer's usual hide-don't-unmount rule here:
    it flips once per session lifetime, and the alternative is keeping a
    GitDropdown and a RunOnPicker alive for every tab forever. It sits above the
    card rather than inside it: it describes the session about to start, not the
    message being composed.
  -->
  {#if !started}
    <InputBarHeader {tabId} />
  {/if}
  <div
    class={cn(
      "min-h-[5.5rem] overflow-hidden rounded-[1.375rem] border bg-(--solus-input-pill-bg) transition-[border-color,box-shadow] duration-[180ms]",
      focused
        ? "border-(--solus-input-focus-border) shadow-[0_0_0_3px_var(--solus-input-focus-ring)]"
        : "border-(--solus-container-border)",
    )}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    <div class="px-3.5 pt-1 pb-2">
      <InputBar mode="editor" {tabId}>
        {#snippet leadingActions()}
          <InputToolbar
            mode="editor"
            {tabId}
            {onAttachFile}
            {onScreenshot}
            {onDesignMode}
            {trailingActions}
          />
        {/snippet}
      </InputBar>
    </div>
  </div>
</div>
