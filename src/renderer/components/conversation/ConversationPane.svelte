<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ArrowUpIcon,
    ChatCircleIcon,
    SquareIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { PlanReference, WorkReference } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { tooltip } from "../../lib/tooltip";
  import PromptEditor from "../ui/PromptEditor.svelte";
  import ConversationView from "./ConversationView.svelte";

  interface Props {
    tabId: string;
    onClose: () => void;
  }
  let { tabId, onClose }: Props = $props();

  const session = getWorkspaceContext();
  const theme = getSettingsContext();

  const tab = $derived(session.tabs[tabId]);
  const sess = $derived(session.sessionFor(tabId));
  const isBusy = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const isConnecting = $derived(sess?.status === "connecting");
  const isReadOnly = $derived(!!sess?.readOnlyReason);
  const provider = $derived(sess?.provider ?? theme.activeAgent);
  const pluginCommands = $derived(
    sess?.pluginCommands ?? session.pluginCommands,
  );
  const canSend = $derived(
    !isConnecting && !isReadOnly && (tab?.input.text.trim().length ?? 0) > 0,
  );
  const placeholder = $derived(
    isReadOnly
      ? (sess?.readOnlyReason ?? "This session is read-only.")
      : isConnecting
        ? "Initializing..."
        : isBusy
          ? "Type to queue a message..."
          : provider === "codex"
            ? "Ask Codex anything..."
            : "Ask Claude Code anything...",
  );

  let composerEl: ReturnType<typeof PromptEditor> | null = $state(null);
  let composerFocused = $state(false);

  const headerButton =
    "flex size-(--solus-tap-target) shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)";

  /** Mirror the editor's plan/work ref tokens onto this tab's draft, like the
   *  main InputBar does for the active tab. */
  function handleRefsChange(
    nextPlanRefs: PlanReference[],
    nextWorkRefs: WorkReference[],
  ) {
    const input = tab?.input;
    if (!input) return;
    if (nextPlanRefs.length || input.planRefs.length)
      input.planRefs = nextPlanRefs;
    if (nextWorkRefs.length || input.workRefs.length)
      input.workRefs = nextWorkRefs;
  }

  function handleSend() {
    if (!tab || !canSend) return;
    const prompt = tab.input.text.trim();
    tab.input.text = "";
    composerEl?.clearEditor();
    session.sendMessage(prompt, undefined, tabId);
    composerEl?.focus();
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInterrupt() {
    session.interruptTab(tabId);
    window.solus.stopTab(session.ctxFor(tabId));
  }

  /** Promote this chat to the main view — selecting a split tab closes the
   *  split (the same conversation can't be shown twice). */
  function openAsMainTab() {
    session.selectTab(tabId);
  }
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
>
  <header
    class="flex h-(--solus-chrome-row-h,var(--solus-tap-target-lg)) shrink-0 items-center gap-2 border-b border-(--solus-chrome-row-border,var(--solus-container-border)) px-3"
  >
    <ChatCircleIcon
      size={13}
      weight="duotone"
      class="shrink-0 text-(--solus-text-tertiary)"
    />
    <div
      class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-(--solus-text-primary)"
    >
      {tab?.title || "New chat"}
    </div>
    <button
      type="button"
      class={headerButton}
      aria-label="Open as main tab"
      onclick={openAsMainTab}
      use:tooltip={"Open as main tab"}
    >
      <ArrowSquareOutIcon size={13} weight="bold" />
    </button>
    <button
      type="button"
      class={headerButton}
      aria-label="Close split chat"
      onclick={onClose}
      use:tooltip={"Close split"}
    >
      <XIcon size={13} weight="bold" />
    </button>
  </header>

  <div class="flex min-h-0 flex-1 flex-col">
    <ConversationView {tabId} forceVisible />
  </div>

  <div class="shrink-0 px-3 pt-1.5 pb-3">
    <div
      class="flex items-end gap-2 rounded-2xl border px-3 py-1 transition-[box-shadow,border-color] duration-150 {composerFocused
        ? 'border-(--solus-input-focus-border) shadow-[0_0_0_3px_var(--solus-input-focus-ring)]'
        : 'border-(--solus-container-border)'}"
      style="background:var(--solus-input-pill-bg)"
      onfocusin={() => (composerFocused = true)}
      onfocusout={() => (composerFocused = false)}
    >
      <div class="min-w-0 flex-1">
        <PromptEditor
          bind:this={composerEl}
          value={tab?.input.text ?? ""}
          onValueChange={(md) => {
            if (tab && !isReadOnly) tab.input.text = md;
          }}
          {pluginCommands}
          {provider}
          workingDirectory={sess?.workingDirectory}
          onRefsChange={handleRefsChange}
          onKeyDown={handleKeyDown}
          onPlanRefClick={(planId) => session.openPlanModal(planId)}
          onWorkRefClick={(workId, title) =>
            session.openWorkModal(workId, title)}
          {placeholder}
          readOnly={isReadOnly}
          disabled={isReadOnly || isConnecting}
          maxHeight={180}
        />
      </div>
      <div class="flex shrink-0 items-center gap-1 pb-[0.375rem]">
        {#if isBusy}
          <button
            onmousedown={(e) => e.preventDefault()}
            onclick={handleInterrupt}
            class="flex size-7 items-center justify-center rounded-full bg-(--solus-stop-bg) text-(--solus-text-on-accent) shadow-[0_0.125rem_0.5rem_rgba(239,68,68,0.24),0_0.0625rem_0.125rem_rgba(0,0,0,0.2)] transition-[box-shadow,transform,background] duration-150 hover:bg-(--solus-stop-hover) active:scale-[0.94]"
            aria-label="Stop current task"
            use:tooltip={"Stop current task"}
          >
            <SquareIcon size={10} weight="fill" />
          </button>
        {/if}
        {#if canSend}
          <button
            onclick={handleSend}
            class="flex size-7 items-center justify-center rounded-full bg-[linear-gradient(145deg,#e08868_0%,#d97757_40%,#c96442_100%)] text-(--solus-text-on-accent) shadow-[0_0.125rem_0.5rem_var(--solus-send-glow),0_0.0625rem_0.125rem_rgba(0,0,0,0.2)] transition-[box-shadow,transform] duration-150 hover:shadow-[0_0.1875rem_0.75rem_var(--solus-send-glow),0_0.0625rem_0.1875rem_rgba(0,0,0,0.25)] active:scale-[0.94]"
            aria-label={isBusy ? "Queue message" : "Send"}
            use:tooltip={isBusy ? "Queue message" : "Send (Enter)"}
          >
            <ArrowUpIcon size={14} weight="bold" />
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>
