<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ArrowsClockwiseIcon,
    BookOpenTextIcon,
    ChatCircleIcon,
    ChatTextIcon,
    CheckIcon,
    CircleNotchIcon,
    DotsThreeIcon,
  } from "phosphor-svelte";
  import type { PullRequestDetail } from "../../../shared/providers";
  import type { IpcContext } from "../../../shared/types";
  import type { PrGuideStatus } from "../../../shared/review";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import MergeControl from "./MergeControl.svelte";
  import ResolveConflictsButton from "./ResolveConflictsButton.svelte";

  // The PR's action cluster, Linear-style: it lives with the merge-readiness
  // status in the right rail (and as a compact fallback when the rail is
  // hidden), not in the page header. One full-width primary CTA; every
  // secondary action is a quiet text row beneath it, with the rarely-used
  // ones behind the ⋯ menu.
  let {
    pr,
    detail,
    showRemoteLink,
    prUrl,
    onOpenRemote,
    feedbackCount = 0,
    guideStatus,
    onGenerateGuide,
    addressCommentsReady = true,
    addressingComments = false,
    onAddressComments,
    onChat,
    getCtx,
    onRefresh,
  }: {
    pr: { number: number; title: string; host?: string };
    detail: PullRequestDetail | null;
    showRemoteLink: boolean;
    prUrl: string | null;
    onOpenRemote: () => void;
    feedbackCount?: number;
    /** Background guide-generation lifecycle for this PR (guides are opt-in). */
    guideStatus?: PrGuideStatus;
    onGenerateGuide?: () => void;
    addressCommentsReady?: boolean;
    addressingComments?: boolean;
    onAddressComments?: () => void;
    onChat?: () => void;
    getCtx: () => IpcContext;
    onRefresh: () => void;
  } = $props();

  let overflowOpen = $state(false);
  let overflowTriggerEl = $state<HTMLButtonElement | null>(null);

  const generatingGuide = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  // Every action except ⋯ is gated on the PR still being open, so a merged or
  // closed PR collapses the footer row down to the overflow menu.
  const showAddressComments = $derived(
    !!onAddressComments &&
      feedbackCount > 0 &&
      detail?.state === "open" &&
      !detail.draft &&
      !detail.headRepo.isFork,
  );
  const showGuide = $derived(
    !!onGenerateGuide && detail?.state === "open" && !detail.draft,
  );
  // Guide stays a quiet text action. Feedback is the higher-intent action, so it
  // gets its own full-width outlined row beneath Merge instead of competing for
  // horizontal room with Guide and the overflow menu.
  const quietButtonClass =
    "h-auto min-w-0 cursor-pointer gap-1.5 rounded-none border-0 bg-transparent p-0 text-[12.5px] transition-colors hover:bg-transparent";

  function runOverflowAction(action: () => void) {
    overflowOpen = false;
    action();
    requestInputFocus();
  }
</script>

<div class="flex w-full flex-col gap-3">
  {#if detail?.state === "open" && !detail.draft}
    {#if detail.mergeStateStatus === "dirty"}
      <ResolveConflictsButton
        pr={{ number: pr.number, title: pr.title }}
        {getCtx}
      />
    {:else}
      <MergeControl pr={{ number: pr.number, title: pr.title }} {getCtx} />
    {/if}
  {/if}

  {#if showAddressComments}
    <Button
      variant="ghost"
      disabled={!addressCommentsReady || addressingComments}
      class="flex h-[34px] w-full min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] font-medium text-foreground shadow-[0_1px_1px_rgba(0,0,0,0.02)] transition-[background-color,border-color,scale] hover:border-[color-mix(in_oklab,var(--foreground)_18%,var(--border))] hover:bg-muted active:scale-[0.96]"
      title={addressingComments
        ? "Opening fix agent…"
        : addressCommentsReady
          ? `Send ${feedbackCount} ${feedbackCount === 1 ? "comment" : "comments"} to an agent`
          : "Preparing the PR worktree…"}
      onclick={onAddressComments}
    >
      {#if addressingComments}
        <CircleNotchIcon
          size={14}
          class="shrink-0 animate-spin [animation-duration:0.9s]"
        />
      {:else}
        <ChatTextIcon size={14} weight="bold" class="shrink-0" />
      {/if}
      <span class="truncate">
        Send {feedbackCount} {feedbackCount === 1 ? "comment" : "comments"} to agent
      </span>
    </Button>
  {/if}

  <!-- Guide and the overflow menu share the quiet footer row from the
       reference. They remain visible alongside the full-width agent action. -->
  <div class="mt-1 flex min-h-6 items-center gap-2">
    {#if showGuide}
      <Button
        variant="ghost"
        size="sm"
        disabled={generatingGuide}
        class="{quietButtonClass} font-normal text-muted-foreground hover:text-foreground"
        aria-label="Generate the review guide in the background"
        title={generatingGuide
          ? "Generating the review guide…"
          : guideStatus === "ready"
            ? "Guide ready — regenerates only if the PR changed"
            : guideStatus === "failed"
              ? "Guide generation failed — try again"
              : "Generate the review guide in the background"}
        onclick={onGenerateGuide}
      >
        {#if generatingGuide}
          <CircleNotchIcon
            size={12}
            class="shrink-0 animate-spin [animation-duration:0.9s]"
          />
        {:else if guideStatus === "ready"}
          <CheckIcon
            size={12}
            weight="bold"
            class="shrink-0 text-(--solus-art-positive)"
          />
        {:else}
          <BookOpenTextIcon size={12} class="shrink-0" />
        {/if}
        <span class="truncate">
          {guideStatus === "queued"
            ? "Guide queued"
            : guideStatus === "generating"
              ? "Generating guide…"
              : guideStatus === "ready"
                ? "Guide ready"
                : "Guide"}
        </span>
      </Button>
    {/if}

    <Button
      bind:ref={overflowTriggerEl}
      variant="ghost"
      size="icon-sm"
      class="ml-auto size-auto shrink-0 cursor-pointer rounded-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-transparent hover:text-foreground"
      aria-label="More pull request actions"
      aria-haspopup="menu"
      aria-expanded={overflowOpen}
      title="More actions"
      onclick={() => (overflowOpen = !overflowOpen)}
    >
      <DotsThreeIcon size={14} weight="bold" />
    </Button>
  </div>

  <DropdownMenu.Root bind:open={overflowOpen}>
    <DropdownMenu.Content
      customAnchor={overflowTriggerEl}
      side="bottom"
      align="end"
      sideOffset={6}
      class="w-44"
    >
      {#if onChat}
        <DropdownMenu.Item onSelect={() => runOverflowAction(onChat)}>
          <ChatCircleIcon size={14} weight="bold" />
          Open agent chat
        </DropdownMenu.Item>
      {/if}
      {#if showRemoteLink && prUrl}
        <DropdownMenu.Item onSelect={() => runOverflowAction(onOpenRemote)}>
          <ArrowSquareOutIcon size={14} weight="bold" />
          Open on {pr.host ?? "remote"}
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item onSelect={() => runOverflowAction(onRefresh)}>
        <ArrowsClockwiseIcon size={14} />
        Refresh activity
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
