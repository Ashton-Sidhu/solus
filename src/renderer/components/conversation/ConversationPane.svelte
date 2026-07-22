<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ArrowsInSimpleIcon,
    ArrowsOutSimpleIcon,
    ChatCircleIcon,
    DotsThreeIcon,
    GitForkIcon,
    TreeStructureIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getPlanStore, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    attentionLabel,
    getAttentionState,
    getStatusIcon,
    projectByline,
  } from "../../lib/sessionUtils";
  import { tooltip } from "../../lib/tooltip";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ConversationView from "./ConversationView.svelte";

  interface Props {
    tabId: string;
    onClose: () => void;
    onAttachFile?: (tabId?: string) => void | Promise<void>;
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null;
    onDesignMode?: ((tabId?: string) => void | Promise<void>) | null;
    onToggleMaximize?: () => void;
  }
  let {
    tabId,
    onClose,
    onAttachFile,
    onScreenshot,
    onDesignMode,
    onToggleMaximize,
  }: Props = $props();

  const session = getWorkspaceContext();
  const planStore = getPlanStore();
  const panes = session.panes;

  const tab = $derived(session.tabs[tabId]);
  const splitSession = $derived(session.sessionFor(tabId));
  const attention = $derived(
    tab && splitSession
      ? getAttentionState(splitSession, tab, planStore.plans)
      : null,
  );
  const statusIcon = $derived(
    splitSession ? getStatusIcon(splitSession.status) : null,
  );
  const statusLabel = $derived(
    attentionLabel(attention) || splitSession?.status.replaceAll("_", " ") || "",
  );
  const splitProjectByline = $derived(projectByline(splitSession));

  let overflowOpen = $state(false);

  async function attachFile() {
    if (onAttachFile) {
      await onAttachFile(tabId);
      return;
    }
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0) return;
    session.addAttachments(files, tabId);
  }

  function toggleDiff() {
    panes.toggleDiff(!!splitSession?.workingDirectory, tabId);
  }

  function closeSplit() {
    if (panes.chatTabIn("secondary", session.activeTabId) === tabId) {
      session.closeSplitChat();
    } else {
      onClose();
    }
  }
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
  onfocusin={() => panes.focusPane("secondary")}
>
  <header
    class="flex h-(--solus-chrome-row-h,var(--solus-tap-target-lg)) shrink-0 items-center gap-2 border-b border-(--solus-chrome-row-border,var(--solus-container-border)) px-3"
  >
    {#if statusIcon}
      {@const StatusIcon = statusIcon.component}
      <span
        class="flex shrink-0 items-center justify-center"
        style="color:{statusIcon.color}"
        aria-label={statusLabel}
        use:tooltip={statusLabel}
      >
        <StatusIcon
          size={12}
          weight="regular"
          class={statusIcon.spin ? "animate-spin motion-reduce:animate-none" : ""}
        />
      </span>
    {:else}
      <ChatCircleIcon
        size={13}
        weight="duotone"
        class="shrink-0 text-(--solus-text-tertiary)"
        aria-hidden="true"
      />
    {/if}
    <div class="flex min-w-0 flex-1 items-baseline gap-2">
      <span
        class="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-(--solus-text-primary)"
        title={tab?.title || "New chat"}
      >
        {tab?.title || "New chat"}
      </span>
      <span
        class="min-w-0 shrink-[10] truncate text-[0.6875rem] text-(--solus-text-tertiary)"
        title={splitProjectByline}
      >
        {splitProjectByline}
      </span>
    </div>
    {#if onToggleMaximize}
      <span use:tooltip={panes.maximized ? "Restore" : "Maximize"}>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          onclick={onToggleMaximize}
          aria-label={panes.maximized ? "Restore panel" : "Maximize panel"}
          class="rounded [&_svg:not([class*='size-'])]:size-3 text-(--solus-text-tertiary) pointer-coarse:size-10"
        >
          {#if panes.maximized}
            <ArrowsInSimpleIcon size={13} weight="bold" />
          {:else}
            <ArrowsOutSimpleIcon size={13} weight="bold" />
          {/if}
        </Button>
      </span>
    {/if}
    <DropdownMenu.Root
      bind:open={overflowOpen}
      onOpenChange={(open) => {
        if (!open) requestInputFocus();
      }}
    >
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <span class="inline-flex" use:tooltip={overflowOpen ? null : "More actions"}>
            <Button
              {...props}
              variant="ghost"
              size="icon"
              type="button"
              aria-label="Split chat actions"
              class="rounded [&_svg:not([class*='size-'])]:size-3 text-(--solus-text-tertiary) pointer-coarse:size-10"
            >
              <DotsThreeIcon size={13} weight="bold" />
            </Button>
          </span>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[200px]">
        <DropdownMenu.Item
          disabled={!splitSession?.agentSessionId}
          onSelect={() => void session.forkTab(tabId)}
        >
          <GitForkIcon />
          Fork Session
        </DropdownMenu.Item>
        {#if !splitSession?.gitContext?.worktreePath}
          <DropdownMenu.Item
            disabled={!splitSession?.agentSessionId || session.isContinuingInWorktree(tabId)}
            onSelect={() => void session.continueInWorktree(tabId)}
          >
            <TreeStructureIcon
              class={session.isContinuingInWorktree(tabId)
                ? "animate-spin motion-reduce:animate-none"
                : ""}
            />
            {session.isContinuingInWorktree(tabId)
              ? "Creating Worktree…"
              : "Continue in Worktree"}
          </DropdownMenu.Item>
        {/if}
        <DropdownMenu.Separator />
        <DropdownMenu.Item onSelect={() => session.promoteSplitToMainTab()}>
          <ArrowSquareOutIcon />
          Open as main tab
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    <span use:tooltip={"Close"}>
      <Button
        variant="ghost"
        size="icon"
        type="button"
        onclick={() => {
          closeSplit();
          requestInputFocus();
        }}
        aria-label="Close split"
        class="rounded [&_svg:not([class*='size-'])]:size-3 text-(--solus-text-tertiary) pointer-coarse:size-10"
      >
        <XIcon size={13} weight="bold" />
      </Button>
    </span>
  </header>

  <div class="flex min-h-0 flex-1 flex-col">
    <ConversationView {tabId} onDiffToggle={toggleDiff} forceVisible />
  </div>

  <div class="shrink-0 px-4 pt-2.5 pb-3">
    <EditorInputCard
      class="mx-auto max-w-(--solus-reading-max)"
      {tabId}
      onAttachFile={attachFile}
      onScreenshot={onScreenshot ? () => onScreenshot(tabId) : null}
      onDesignMode={onDesignMode ? () => onDesignMode(tabId) : null}
    />
  </div>
</div>
