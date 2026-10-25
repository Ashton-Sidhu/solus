<script lang="ts">
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";
  import {
    ExternalLink as ArrowSquareOutIcon,
    RotateCw as ArrowClockwiseIcon,
    MessageCircleQuestion as ChatCircleQuestionIcon,
    Copy as CopyIcon,
    Ellipsis as DotsThreeIcon,
    ClipboardCheck as GuideIcon,
    GitPullRequest as GitPullRequestIcon,
    Hammer as HammerIcon,
    Link as LinkIcon,
    Pen as PencilSimpleIcon,
    Undo2 as UndoIcon,
  } from "@lucide/svelte";
  import { tick } from "svelte";
  import type {
    PrLifecycleAction,
    PrStateAction,
    PullRequest,
  } from "@solus/contracts/providers";
  import type { ReviewGuideStatus } from "@solus/contracts/review";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { copyText, toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PrActionConfirm from "./PrActionConfirm.svelte";
  import { prMenuHostActions } from "./lib/merge-readiness";

  /**
   * The pull request's one ⋯ menu. The review's band carries it on every tab
   * and in both shapes (the panel beside the list and the full route); Review
   * Mode, which has no band, hands it to the Activity status card instead. So
   * a pull request never shows two.
   *
   * The band keeps the actions taken in the moment — Review, Check out, and
   * the merge move. Everything used once a session lives here, in four groups:
   * the pull request's references, the host page, the agent handoffs and the
   * review guide, then the host writes that change the pull request's state.
   */
  let {
    detail,
    hostName,
    headRef,
    prUrl,
    onOpenPage,
    onRefresh,
    refreshing,
    onAskQuestion,
    askQuestionBusy = false,
    onFixComments,
    fixCommentsBusy = false,
    guideStatus,
    onOpenGuide,
    onGenerateGuide,
    onLifecycleAction,
    onRevert,
  }: {
    detail: PullRequest | null;
    /** The code host, for the "Open on …" row. */
    hostName?: string;
    /** The head branch, for the copy row — the one ref you might want to type. */
    headRef?: string;
    prUrl: string | null;
    /** Open the pull request page on its external host. */
    onOpenPage?: () => void;
    onRefresh: () => void;
    refreshing: boolean;
    onAskQuestion?: () => void;
    askQuestionBusy?: boolean;
    /** Absent while there is no feedback to fix. */
    onFixComments?: () => void;
    fixCommentsBusy?: boolean;
    /** The review guide's lifecycle; undefined until one is asked for. */
    guideStatus?: ReviewGuideStatus;
    /** Absent on the guide's own tab. */
    onOpenGuide?: () => void;
    /** Absent while the PR cannot carry a guide (draft, closed, merged). */
    onGenerateGuide?: () => void;
    onLifecycleAction?: (action: PrStateAction) => Promise<void>;
    onRevert?: () => Promise<void>;
  } = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let lifecycleAction = $state<PrLifecycleAction | null>(null);
  let confirmOpen = $state(false);

  const generatingGuide = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  const canOpenGuide = $derived(!!onOpenGuide && !!guideStatus && !generatingGuide);
  const guideOutdated = $derived(guideStatus === "outdated");

  const showRevert = $derived(
    !!onRevert && !!detail && prMenuHostActions(detail, null).revert,
  );
  const allowedActions = $derived(
    new Set(detail?.viewerPermissions.actions ?? []),
  );
  const readyAction = $derived(
    !onLifecycleAction || detail?.state !== "open"
      ? null
      : detail.draft
        ? allowedActions.has("ready") ? "ready" : null
        : allowedActions.has("draft") ? "draft" : null,
  );
  const stateAction = $derived(
    !onLifecycleAction
      ? null
      : detail?.state === "open" && allowedActions.has("close")
        ? "close"
        : detail?.state === "closed" && allowedActions.has("reopen")
          ? "reopen"
          : null,
  );
  const showAgentGroup = $derived(
    !!onAskQuestion || !!onFixComments || canOpenGuide || !!onGenerateGuide,
  );
  const showHostGroup = $derived(showRevert || !!readyAction || !!stateAction);

  /**
   * Close the menu, then act. A row here can restructure the workspace under
   * the click that chose it: opening the review's session moves the review to
   * the leading pane and mounts a conversation beside it, which tears down the
   * surface this floating menu is anchored in while `onSelect` is still
   * running. Acting one tick after the menu is gone keeps that teardown out of
   * the handler.
   */
  async function runAction(action: () => void): Promise<void> {
    open = false;
    await tick();
    action();
    requestInputFocus();
  }

  async function copy(text: string): Promise<void> {
    open = false;
    await copyText(text);
    requestInputFocus();
  }

  async function runHostAction(
    action: PrLifecycleAction,
    write: () => Promise<void>,
    failure: string,
  ) {
    if (lifecycleAction) return;
    open = false;
    lifecycleAction = action;
    try {
      await write();
    } catch (error) {
      toasts.error(failure, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      lifecycleAction = null;
      requestInputFocus();
    }
  }

  function updateLifecycle(action: PrStateAction) {
    if (!onLifecycleAction) return;
    const run = onLifecycleAction;
    void runHostAction(action, () => run(action), "Couldn't update the pull request");
  }

  function confirmRevert() {
    open = false;
    confirmOpen = true;
  }

  function runRevert() {
    if (onRevert) void runHostAction("revert", onRevert, "Couldn't open a revert pull request");
  }
</script>

<button
  bind:this={triggerEl}
  type="button"
  class="{PAGE_SOFT_ICON_BTN} relative {open ? 'bg-[var(--wash-1)]! text-foreground!' : ''}"
  aria-label={guideOutdated
    ? "More pull request actions — guide is outdated"
    : "More pull request actions"}
  aria-haspopup="menu"
  aria-expanded={open}
  title={guideOutdated ? "Guide is outdated" : "More actions"}
  onclick={() => (open = !open)}
>
  <DotsThreeIcon class="size-[15px]" strokeWidth={1.5} />
  {#if guideOutdated}
    <span
      class="absolute top-[3px] right-[3px] size-[5px] rounded-full bg-primary"
      aria-hidden="true"
    ></span>
  {/if}
  <span
    class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
    aria-hidden="true"
  ></span>
</button>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={triggerEl}
    side="bottom"
    align="end"
    sideOffset={6}
    class="w-[min(20rem,calc(100vw-2rem))] [&_.menu-row]:text-workspace-chrome"
    onInteractOutside={(event) => {
      // The trigger is a custom anchor, so Bits UI otherwise treats its
      // pointer-down as an outside interaction and closes the menu before the
      // button's click can toggle it. Keep the current state until that click.
      if (triggerEl?.contains(event.target as Node)) event.preventDefault();
    }}
  >
    <!-- The references that name this pull request, and the host page. True
         on every tab, so they hold the top rows and never move. Every label
         but the question's stays on one line — a menu row is a fixed 32px. -->
    {#if headRef}
      {@const branch = headRef}
      <DropdownMenu.Item onSelect={() => void copy(branch)}>
        <CopyIcon size={14} />
        <span class="whitespace-nowrap">Copy branch name</span>
      </DropdownMenu.Item>
    {/if}
    {#if prUrl}
      {@const url = prUrl}
      <DropdownMenu.Item onSelect={() => void copy(url)}>
        <LinkIcon size={14} />
        Copy link
      </DropdownMenu.Item>
    {/if}
    {#if onOpenPage}
      {@const openPage = onOpenPage}
      <DropdownMenu.Item onSelect={() => void runAction(openPage)}>
        <ArrowSquareOutIcon size={14} />
        Open on {hostName?.includes("github") ? "GitHub" : (hostName ?? "remote")}
      </DropdownMenu.Item>
    {/if}
    <DropdownMenu.Item
      disabled={refreshing}
      onSelect={() => void runAction(onRefresh)}
    >
      <ArrowClockwiseIcon
        size={14}
        class={refreshing ? "animate-spin [animation-duration:0.9s] motion-reduce:animate-none" : ""}
      />
      {refreshing ? "Refreshing…" : "Refresh pull request"}
    </DropdownMenu.Item>

    {#if showAgentGroup}
      <DropdownMenu.Separator />
    {/if}
    {#if onAskQuestion}
      {@const ask = onAskQuestion}
      <DropdownMenu.Item
        disabled={askQuestionBusy}
        class="h-auto min-h-11 items-start gap-2.5 py-2"
        onSelect={() => void runAction(ask)}
      >
        <ChatCircleQuestionIcon size={14} class="mt-0.5 shrink-0" />
        <span class="flex min-w-0 flex-1 flex-col gap-px">
          <span>{askQuestionBusy ? "Preparing…" : "Ask a question"}</span>
          <span class="text-xs leading-[1.35] text-muted-foreground">
            Opens a PR-aware session with an editable question.
          </span>
        </span>
      </DropdownMenu.Item>
    {/if}
    {#if onFixComments}
      {@const fix = onFixComments}
      <DropdownMenu.Item
        disabled={fixCommentsBusy}
        onSelect={() => void runAction(fix)}
      >
        <HammerIcon size={14} />
        {fixCommentsBusy ? "Preparing…" : "Draft fixes for comments"}
      </DropdownMenu.Item>
    {/if}
    <!-- The review guide is a reading aid, not a merge move. The label
         carries its state: in flight, failed, outdated, or ready to open. -->
    {#if canOpenGuide && onOpenGuide}
      {@const openGuide = onOpenGuide}
      <DropdownMenu.Item onSelect={() => void runAction(openGuide)}>
        <GuideIcon size={14} />
        Open review guide
      </DropdownMenu.Item>
    {/if}
    {#if onGenerateGuide}
      {@const generate = onGenerateGuide}
      <DropdownMenu.Item
        disabled={generatingGuide}
        onSelect={() => void runAction(generate)}
      >
        <GuideIcon size={14} />
        {generatingGuide
          ? "Generating review guide…"
          : guideStatus === "failed"
            ? "Retry review guide"
            : guideStatus
              ? "Regenerate review guide"
              : "Generate review guide"}
      </DropdownMenu.Item>
    {/if}

    {#if showHostGroup}
      <DropdownMenu.Separator />
    {/if}
    {#if showRevert}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={confirmRevert}
      >
        <UndoIcon size={14} />
        Revert changes
      </DropdownMenu.Item>
    {/if}
    {#if readyAction === "ready"}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={() => updateLifecycle("ready")}
      >
        <GitPullRequestIcon size={14} />
        Mark ready for review
      </DropdownMenu.Item>
    {:else if readyAction === "draft"}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={() => updateLifecycle("draft")}
      >
        <PencilSimpleIcon size={14} />
        Convert to draft
      </DropdownMenu.Item>
    {/if}
    {#if stateAction === "close"}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={() => updateLifecycle("close")}
      >
        <GitPullRequestIcon size={14} />
        Close pull request
      </DropdownMenu.Item>
    {:else if stateAction === "reopen"}
      <DropdownMenu.Item
        disabled={!!lifecycleAction}
        onSelect={() => updateLifecycle("reopen")}
      >
        <GitPullRequestIcon size={14} />
        Reopen pull request
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<PrActionConfirm
  bind:open={confirmOpen}
  title="Revert these changes?"
  description="This opens a new pull request that reverses the changes merged by #{detail?.number ?? ''}."
  confirmLabel="Create revert PR"
  onConfirm={runRevert}
/>
