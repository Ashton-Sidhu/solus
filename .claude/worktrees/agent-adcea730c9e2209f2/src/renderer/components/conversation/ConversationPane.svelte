<script lang="ts">
  import { ArrowSquareOutIcon, ChatCircleIcon, XIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { tooltip } from "../../lib/tooltip";
  import InputBarRow from "../input/InputBarRow.svelte";
  import StatusBarControls from "../layout/StatusBarControls.svelte";
  import ConversationView from "./ConversationView.svelte";

  interface Props {
    tabId: string;
    onClose: () => void;
  }
  let { tabId, onClose }: Props = $props();

  const session = getWorkspaceContext();

  const tab = $derived(session.tabs[tabId]);

  let composerFocused = $state(false);

  const headerButton =
    "flex size-(--solus-tap-target) shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)";

  /** Promote this chat to the main view — selecting a split tab closes the
   *  split (the same conversation can't be shown twice). */
  function openAsMainTab() {
    session.selectTab(tabId);
  }

  async function handleAttachFile() {
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0) return;
    session.addAttachments(files, tabId);
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
      class="overflow-hidden rounded-2xl border bg-(--solus-input-pill-bg) transition-[box-shadow,border-color] duration-[180ms] {composerFocused
        ? 'border-(--solus-input-focus-border) shadow-[0_0_0_3px_var(--solus-input-focus-ring),var(--solus-card-shadow-collapsed)]'
        : 'border-(--solus-container-border) shadow-(--solus-card-shadow-collapsed)'}"
      onfocusin={() => (composerFocused = true)}
      onfocusout={() => (composerFocused = false)}
    >
      <InputBarRow mode="editor" {tabId} onAttachFile={handleAttachFile} />
      <div
        class="border-t border-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
      >
        <StatusBarControls dirMaxWidth={240} mode="editor" {tabId} />
      </div>
    </div>
  </div>
</div>
