<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    RefreshCw as ArrowsClockwiseIcon,
    MessageCircleQuestion as ChatCircleQuestionIcon,
    Ellipsis as DotsThreeIcon,
    BookOpen as GuideIcon,
    GitPullRequest as GitPullRequestIcon,
    GitMerge as GitMergeIcon,
    Hammer as HammerIcon,
    Link as LinkIcon,
    Pen as PencilSimpleIcon,
    Undo2 as UndoIcon,
  } from "@lucide/svelte";
  import type {
    PrLifecycleAction,
    PrStateAction,
    PullRequest,
  } from "@solus/contracts/providers";
  import type { MergeMethod } from "@solus/contracts/types";
  import type { ReviewGuideStatus } from "@solus/contracts/review";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { copyText, toasts } from "../../lib/toasts";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import PrActionConfirm from "./PrActionConfirm.svelte";
  import { MERGE_METHOD_OPTIONS } from "./lib/merge-method";
  import { prMenuHostActions, type MergeAction } from "./lib/merge-readiness";

  // Pull request actions that do not need a permanent button. The menu rides
  // in the status card beside the merge state, so the PR-aware agent handoffs
  // and host commands stay available even when the rail moves under the title.
  let {
    pr,
    detail,
    showRemoteLink,
    prUrl,
    onOpenRemote,
    onAskQuestion,
    onFixComments,
    askQuestionBusy = false,
    fixCommentsBusy = false,
    onRefresh,
    onLifecycleAction,
    primaryAction = null,
    onEnableAutoMerge,
    onDisableAutoMerge,
    onMergeNow,
    onRevert,
    guideStatus,
    onGenerateGuide,
    onOpenGuide,
  }: {
    pr: { host?: string };
    detail: PullRequest | null;
    showRemoteLink: boolean;
    prUrl: string | null;
    onOpenRemote: () => void;
    onAskQuestion?: () => void;
    onFixComments?: () => void;
    askQuestionBusy?: boolean;
    fixCommentsBusy?: boolean;
    onRefresh?: () => void;
    onLifecycleAction?: (action: PrStateAction) => Promise<void>;
    /** The move the status card already offers, so the menu offers the
     *  others: "Merge now" beside an auto-merge, not a second auto-merge. */
    primaryAction?: MergeAction | null;
    onEnableAutoMerge?: (method: MergeMethod) => Promise<void>;
    onDisableAutoMerge?: () => Promise<void>;
    onMergeNow?: (method: MergeMethod) => Promise<void>;
    onRevert?: () => Promise<void>;
    /** The review guide's lifecycle; undefined until one is asked for. */
    guideStatus?: ReviewGuideStatus;
    /** Absent while the PR cannot carry a guide (draft, closed, merged). */
    onGenerateGuide?: () => void;
    onOpenGuide?: () => void;
  } = $props();

  const generatingGuide = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  const canOpenGuide = $derived(!!onOpenGuide && !!guideStatus && !generatingGuide);

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let lifecycleAction = $state<PrLifecycleAction | null>(null);
  // The host action waiting on the reader's answer in the confirmation.
  let confirming = $state<"enable-auto-merge" | "revert" | null>(null);
  let confirmOpen = $state(false);

  const hostActions = $derived(
    detail ? prMenuHostActions(detail, primaryAction) : null,
  );
  const methodLabel = $derived(
    (
      MERGE_METHOD_OPTIONS.find((option) => option.value === hostActions?.method)
        ?.label ?? "Merge commit"
    ).toLowerCase(),
  );
  const showEnableAutoMerge = $derived(
    !!onEnableAutoMerge && !!hostActions?.enableAutoMerge,
  );
  const showDisableAutoMerge = $derived(
    !!onDisableAutoMerge && !!hostActions?.disableAutoMerge,
  );
  const showMergeNow = $derived(!!onMergeNow && !!hostActions?.mergeNow);
  const showRevert = $derived(!!onRevert && !!hostActions?.revert);
  const hasHostAction = $derived(
    showEnableAutoMerge || showDisableAutoMerge || showMergeNow || showRevert,
  );

  const allowedActions = $derived(
    new Set(detail?.viewerPermissions.actions ?? []),
  );
  const hasLifecycleAction = $derived(
    !!onLifecycleAction &&
      ((detail?.state === "open" &&
        detail.draft &&
        allowedActions.has("ready")) ||
        (detail?.state === "open" &&
          !detail.draft &&
          allowedActions.has("draft")) ||
        (detail?.state === "open" && allowedActions.has("close")) ||
        (detail?.state === "closed" && allowedActions.has("reopen"))),
  );
  const hasItems = $derived(
    !!onAskQuestion ||
      !!onFixComments ||
      (showRemoteLink && !!prUrl) ||
      !!prUrl ||
      !!onRefresh ||
      !!onGenerateGuide ||
      canOpenGuide ||
      hasLifecycleAction ||
      hasHostAction,
  );

  function runAction(action: () => void) {
    open = false;
    action();
    requestInputFocus();
  }

  async function copyPullRequestLink() {
    if (!prUrl) return;
    open = false;
    await copyText(prUrl);
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

  function confirm(action: "enable-auto-merge" | "revert") {
    open = false;
    confirming = action;
    confirmOpen = true;
  }

  function runConfirmed() {
    const method = hostActions?.method;
    if (confirming === "enable-auto-merge" && onEnableAutoMerge && method) {
      const run = onEnableAutoMerge;
      void runHostAction("enable-auto-merge", () => run(method), "Couldn't turn on auto-merge");
    } else if (confirming === "revert" && onRevert) {
      void runHostAction("revert", onRevert, "Couldn't open a revert pull request");
    }
  }
</script>

{#if hasItems}
  <Button
    bind:ref={triggerEl}
    variant="ghost"
    size="icon-sm"
    class="relative size-6 shrink-0 cursor-pointer rounded-full bg-transparent p-0 text-muted-foreground transition-colors hover:bg-[var(--wash-3)] hover:text-foreground"
    aria-label="More pull request actions"
    aria-haspopup="menu"
    aria-expanded={open}
    title="More actions"
    onclick={() => (open = !open)}
  >
    <DotsThreeIcon size={14} weight="bold" />
    <span
      class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
      aria-hidden="true"
    ></span>
  </Button>

  <DropdownMenu.Root bind:open>
    <DropdownMenu.Content
      customAnchor={triggerEl}
      side="bottom"
      align="end"
      sideOffset={6}
      class="w-[min(23rem,calc(100vw-2rem))] [&_.menu-row]:text-workspace-chrome"
      onInteractOutside={(event) => {
        if (triggerEl?.contains(event.target as Node)) event.preventDefault();
      }}
    >
      {#if onRefresh}
        <DropdownMenu.Item onSelect={() => runAction(onRefresh)}>
          <ArrowsClockwiseIcon size={14} />
          Refresh
        </DropdownMenu.Item>
      {/if}
      {#if onAskQuestion}
        <DropdownMenu.Item
          disabled={askQuestionBusy}
          class="h-auto min-h-11 items-start gap-2.5 py-2"
          onSelect={() => runAction(onAskQuestion)}
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
        <DropdownMenu.Item
          disabled={fixCommentsBusy}
          onSelect={() => runAction(onFixComments)}
        >
          <HammerIcon size={14} />
          {fixCommentsBusy ? "Preparing…" : "Draft fixes for comments"}
        </DropdownMenu.Item>
      {/if}
      <!-- The review guide is a reading aid, not a merge move, so it lives
           here rather than as a row in the rail. The label carries its state:
           in flight, failed, or ready to open. -->
      {#if canOpenGuide && onOpenGuide}
        {@const openGuide = onOpenGuide}
        <DropdownMenu.Item onSelect={() => runAction(openGuide)}>
          <GuideIcon size={14} />
          Open review guide
        </DropdownMenu.Item>
      {/if}
      {#if onGenerateGuide}
        {@const generate = onGenerateGuide}
        <DropdownMenu.Item
          disabled={generatingGuide}
          onSelect={() => runAction(generate)}
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

      {#if prUrl}
        <DropdownMenu.Separator />
      {/if}
      {#if showRemoteLink && prUrl}
        <DropdownMenu.Item onSelect={() => runAction(onOpenRemote)}>
          <ArrowSquareOutIcon size={14} weight="bold" />
          Open on {pr.host?.includes("github")
            ? "GitHub"
            : (pr.host ?? "remote")}
        </DropdownMenu.Item>
      {/if}
      {#if prUrl}
        <DropdownMenu.Item onSelect={() => void copyPullRequestLink()}>
          <LinkIcon size={14} />
          Copy link
        </DropdownMenu.Item>
      {/if}

      {#if hasLifecycleAction || hasHostAction}
        <DropdownMenu.Separator />
      {/if}
      {#if showMergeNow && onMergeNow && hostActions}
        {@const run = onMergeNow}
        {@const method = hostActions.method}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() =>
            void runHostAction("merge", () => run(method), "Couldn't merge the pull request")}
        >
          <GitMergeIcon size={14} />
          Merge now
        </DropdownMenu.Item>
      {/if}
      {#if showDisableAutoMerge && onDisableAutoMerge}
        {@const run = onDisableAutoMerge}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() =>
            void runHostAction("disable-auto-merge", run, "Couldn't turn off auto-merge")}
        >
          <GitMergeIcon size={14} />
          Disable auto-merge
        </DropdownMenu.Item>
      {:else if showEnableAutoMerge}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => confirm("enable-auto-merge")}
        >
          <GitMergeIcon size={14} />
          Enable auto-merge
        </DropdownMenu.Item>
      {/if}
      {#if showRevert}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => confirm("revert")}
        >
          <UndoIcon size={14} />
          Revert changes
        </DropdownMenu.Item>
      {/if}
      {#if onLifecycleAction && detail?.state === "open" && detail.draft && allowedActions.has("ready")}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => updateLifecycle("ready")}
        >
          <GitPullRequestIcon size={14} />
          Mark ready for review
        </DropdownMenu.Item>
      {:else if onLifecycleAction && detail?.state === "open" && !detail.draft && allowedActions.has("draft")}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => updateLifecycle("draft")}
        >
          <PencilSimpleIcon size={14} />
          Convert to draft
        </DropdownMenu.Item>
      {/if}
      {#if onLifecycleAction && detail?.state === "open" && allowedActions.has("close")}
        <DropdownMenu.Item
          disabled={!!lifecycleAction}
          onSelect={() => updateLifecycle("close")}
        >
          <GitPullRequestIcon size={14} />
          Close pull request
        </DropdownMenu.Item>
      {:else if onLifecycleAction && detail?.state === "closed" && allowedActions.has("reopen")}
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
{/if}

<PrActionConfirm
  bind:open={confirmOpen}
  title={confirming === "revert" ? "Revert these changes?" : "Enable auto-merge?"}
  description={confirming === "revert"
    ? `This opens a new pull request that reverses the changes merged by #${detail?.number ?? ""}.`
    : `This merges #${detail?.number ?? ""} using ${methodLabel} as soon as the host considers it ready, which may be immediately.`}
  confirmLabel={confirming === "revert" ? "Create revert PR" : "Enable auto-merge"}
  onConfirm={runConfirmed}
/>
