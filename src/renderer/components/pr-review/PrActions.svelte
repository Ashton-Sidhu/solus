<script lang="ts">
  import {
    ArrowSquareOutIcon,
    ArrowsClockwiseIcon,
    BookOpenTextIcon,
    ChatCircleIcon,
    CheckIcon,
    CircleNotchIcon,
    DotsThreeIcon,
    RobotIcon,
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
  // closed PR collapses the row down to the lone ⋯. Right-aligning it there
  // strands it in the middle of an empty line; left-aligned it reads as part
  // of the quiet control column alongside "View N checks".
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
  const overflowAlone = $derived(!showAddressComments && !showGuide);
  const quietButtonClass =
    "h-7 cursor-pointer gap-1.5 rounded-lg px-2 text-[0.75rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:scale-[0.96] disabled:active:scale-100";

  function runOverflowAction(action: () => void) {
    overflowOpen = false;
    action();
    requestInputFocus();
  }
</script>

<div class="flex w-full flex-col gap-2.5">
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

  <!-- Secondary actions read as typography, not chrome: no outlines, no
       fills — hover reveals the affordance. Text aligns to the section edge
       (-ml-2 swallows the ghost padding); ⋯ closes the row at the far edge,
       or leads it when it is the only action left. -->
  <div class="-ml-2 flex flex-wrap items-center gap-1">
    {#if showAddressComments}
      <Button
        variant="ghost"
        size="sm"
        disabled={!addressCommentsReady || addressingComments}
        class="h-7 cursor-pointer gap-1.5 rounded-lg px-2 text-[0.75rem] font-medium text-(--solus-accent) transition-[background-color,scale] duration-150 ease-out hover:bg-(--solus-accent-light) hover:text-(--solus-accent) active:scale-[0.96] disabled:active:scale-100"
        title={addressingComments
          ? "Opening fix agent…"
          : addressCommentsReady
            ? `Address ${feedbackCount} ${feedbackCount === 1 ? "feedback item" : "feedback items"} with an agent`
            : "Preparing the PR worktree…"}
        onclick={onAddressComments}
      >
        {#if addressingComments}
          <CircleNotchIcon
            size={13}
            class="shrink-0 animate-spin [animation-duration:0.9s]"
          />
        {:else}
          <RobotIcon size={13} weight="bold" class="shrink-0" />
        {/if}
        Address comments
      </Button>
    {/if}

    {#if showGuide}
      <Button
        variant="ghost"
        size="sm"
        disabled={generatingGuide}
        class={quietButtonClass}
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
            size={13}
            class="shrink-0 animate-spin [animation-duration:0.9s]"
          />
        {:else if guideStatus === "ready"}
          <CheckIcon
            size={13}
            weight="bold"
            class="shrink-0 text-(--solus-art-positive)"
          />
        {:else}
          <BookOpenTextIcon size={13} weight="bold" class="shrink-0" />
        {/if}
        {guideStatus === "ready" ? "Guide ready" : "Guide"}
      </Button>
    {/if}

    <Button
      bind:ref={overflowTriggerEl}
      variant="ghost"
      size="icon-sm"
      class={`${overflowAlone ? "" : "ml-auto"} cursor-pointer text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-150 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:scale-[0.96]`}
      aria-label="More pull request actions"
      aria-haspopup="menu"
      aria-expanded={overflowOpen}
      title="More actions"
      onclick={() => (overflowOpen = !overflowOpen)}
    >
      <DotsThreeIcon size={16} weight="bold" />
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
