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
  <!--
    One card, one hairline, one accent. The card sits flat on the page — a
    half-pixel outline and nothing behind it — so terracotta is spent on focus
    and on send, never on the resting border.
  -->
  <div
    class={cn(
      "overflow-hidden rounded-2xl bg-(--solus-input-pill-bg) px-3 pb-3 transition-[box-shadow] duration-[180ms]",
      focused
        ? "shadow-[shadow:0_0_0_0.0625rem_color-mix(in_oklch,var(--solus-accent)_34%,transparent),0_0_0_0.25rem_color-mix(in_oklch,var(--solus-accent)_9%,transparent)]"
        : "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]",
    )}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    <InputBar mode="editor" {tabId}>
      {#snippet leadingActions(savedPromptsControl)}
        <InputToolbar
          mode="editor"
          {tabId}
          {onAttachFile}
          {onScreenshot}
          {onDesignMode}
          {savedPromptsControl}
          {trailingActions}
        />
      {/snippet}
    </InputBar>
  </div>
</div>
