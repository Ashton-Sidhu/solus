<script lang="ts">
  import {
    ChatTextIcon,
    CheckIcon,
    CircleNotchIcon,
  } from "phosphor-svelte";
  import type { PullRequestDetail } from "@solus/contracts/providers";
  import type { IpcContext } from "@solus/contracts/types";
  import type { PrGuideStatus } from "@solus/contracts/review";
  import { Button } from "../ui/button";
  import MergeControl from "./MergeControl.svelte";
  import ReviewGuideGlyph from "../review/ReviewGuideGlyph.svelte";
  import ResolveConflictsButton from "./ResolveConflictsButton.svelte";
  import type { HostApi } from "@solus/client-core/host-api";

  // The PR's action cluster, Linear-style: it lives with the merge-readiness
  // status in the right rail, not in the page header. One full-width primary
  // CTA; the quiet Guide row sits beneath it. The rarely-used actions are in the
  // ⋯ menu that rides in the section's header (see PrOverflowMenu) — a draft has
  // neither of the actions here, and a footer row left that ⋯ floating alone.
  let {
    pr,
    detail,
    feedbackCount = 0,
    guideStatus,
    onGenerateGuide,
    addressCommentsReady = true,
    addressingComments = false,
    onAddressComments,
    getCtx,
    getApi,
    onDetailChanged,
  }: {
    pr: { number: number; title: string };
    detail: PullRequestDetail | null;
    feedbackCount?: number;
    /** Background guide-generation lifecycle for this PR (guides are opt-in). */
    guideStatus?: PrGuideStatus;
    onGenerateGuide?: () => void;
    addressCommentsReady?: boolean;
    addressingComments?: boolean;
    onAddressComments?: () => void;
    getCtx: () => IpcContext;
    getApi: () => HostApi;
    onDetailChanged?: (detail: PullRequestDetail) => void;
  } = $props();

  const generatingGuide = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  // Every action here is gated on the PR still being open, so a draft, merged,
  // or closed PR renders nothing at all rather than an empty cluster.
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
  // horizontal room with Guide.
  const quietButtonClass =
    "h-auto min-w-0 cursor-pointer gap-1.5 rounded-none border-0 bg-transparent p-0 text-sm transition-colors hover:bg-transparent";
  const allowedActions = $derived(new Set(detail?.viewerPermissions.actions ?? []));
  const mergeMethods = $derived(detail?.capabilities.mergeMethods ?? []);
  const canMerge = $derived(
    !!detail &&
      detail.capabilities.actions.includes("merge") &&
      allowedActions.has("merge") &&
      mergeMethods.length > 0,
  );
  const showMerge = $derived(
    detail?.state === "open" && !detail.draft && canMerge,
  );
  // The cluster owns its own top margin: a draft has none of these actions, and
  // an empty wrapper still held a gap above the section's closing hairline.
  const hasActions = $derived(showMerge || showAddressComments || showGuide);
</script>

{#if hasActions}
<div class="mt-3.5 flex w-full flex-col gap-3">
  {#if showMerge && detail}
    {#if detail.mergeStateStatus === "dirty"}
      <ResolveConflictsButton
        pr={{ number: pr.number, title: pr.title, headSha: detail.headSha }}
        {getCtx}
      />
    {:else}
      <MergeControl
        pr={{ number: pr.number, title: pr.title, headSha: detail.headSha }}
        {getCtx}
        {getApi}
        methods={mergeMethods}
        onMerged={onDetailChanged}
      />
    {/if}
  {/if}

  {#if showAddressComments}
    <Button
      variant="ghost"
      disabled={!addressCommentsReady || addressingComments}
      class="flex h-[34px] w-full min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground shadow-[0_1px_1px_rgba(0,0,0,0.02)] transition-[background-color,border-color,scale] hover:border-[color-mix(in_oklab,var(--foreground)_18%,var(--border))] hover:bg-muted active:scale-[0.96]"
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

  <!-- Guide is a quiet text row under the full-width agent action. It renders
       only when there is a guide to ask for, so nothing holds empty height. -->
  {#if showGuide}
    <div class="mt-1 flex items-center gap-2">
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
          <ReviewGuideGlyph size={12} class="shrink-0" />
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
    </div>
  {/if}
</div>
{/if}
