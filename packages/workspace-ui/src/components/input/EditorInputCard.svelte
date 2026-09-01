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
    /** The pane this card fills, when it fills one of its own. Unset by the
     *  workspace's own dock, which belongs to the leading pane. */
    paneId?: string;
    onAttachFile: () => void | Promise<void>;
    onScreenshot?: (() => void | Promise<void>) | null;
    onDesignMode?: (() => void | Promise<void>) | null;
    trailingActions?: Snippet;
  }

  let {
    class: className,
    tabId,
    paneId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
    trailingActions,
  }: Props = $props();

  const session = getWorkspaceContext();
  // A pinned card names its tab; the workspace's own dock composes for whatever
  // chat is active. Resolving that here means the bar below is handed a session
  // outright and never has to guess one from the tab strip.
  const targetTabId = $derived(tabId ?? session.activeTabId);
  const sess = $derived(session.sessionFor(targetTabId));
  const started = $derived(hasSessionStarted(sess));
  let prompt = $derived(session.inputFor(targetTabId));

  // The workspace dock (no tab of its own) steps aside while a draft holds the
  // leading pane: the draft's composer is the primary then, and it — not this
  // hidden dock — must own app focus and the shared mic. Two primaries would
  // both auto-claim voice, and whichever won left the visible composer mute.
  const isPrimary = $derived(
    tabId === undefined && session.router.leadingPane.base?.name !== "draft",
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
    <!-- Raw `tabId`, not the active-resolved one: unset for the workspace dock,
         which is what keeps it answering the global git-dropdown shortcut. -->
    <InputBarHeader sourceId={tabId} {paneId} />
  {/if}
  <!--
    One card, one hairline, one accent. The card sits flat on the page — a
    half-pixel outline and nothing behind it — so terracotta is spent on focus
    and on send, never on the resting border.
  -->
  <div
    class={cn(
      // The `composer` container. The toolbar row's disclosure ladder measures
      // this card, so it narrows identically whether the cause is a phone, a
      // laptop, or a companion pane opening beside it.
      "@container/composer overflow-hidden rounded-2xl bg-(--solus-input-pill-bg) px-3 pb-3 transition-[box-shadow] duration-[180ms]",
      focused
        ? "shadow-[shadow:0_0_0_0.0625rem_color-mix(in_oklch,var(--solus-accent)_34%,transparent),0_0_0_0.25rem_color-mix(in_oklch,var(--solus-accent)_9%,transparent)]"
        : "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]",
    )}
    onfocusin={() => (focused = true)}
    onfocusout={() => (focused = false)}
  >
    <InputBar
      mode="editor"
      sessionId={sess?.id ?? null}
      tabId={targetTabId}
      {isPrimary}
      {paneId}
      run={sess?.run}
      bind:prompt
    >
      {#snippet leadingActions(savedPromptsControl)}
        <InputToolbar
          mode="editor"
          tabId={targetTabId}
          {isPrimary}
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
