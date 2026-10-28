<script lang="ts">
  import {
    Eye as EyeIcon,
    CircleAlert as AlertIcon,
    CircleX as FailedIcon,
    CircleCheck as PassedIcon,
    CheckCheck as AllPassedIcon,
    CircleDashed as NoChecksIcon,
    MessageSquare as RemarksIcon,
    GitMerge as ConflictIcon,
    GitPullRequestClosed as ClosedIcon,
    EyeOff as StoppedIcon,
  } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import {
    pullRequestWatchWake,
    pullRequestWatchWakeMarks,
    pullRequestWatchWakeSummary,
  } from "@solus/client-core/pull-request-watch-wake";
  import HostNoticeRow from "./HostNoticeRow.svelte";

  /** A pull request watch's wake as a host notice: an eye, the pull request,
   *  and its news as icons with counts — "#42 ⊗ 2 💬 1". A hover or keyboard
   *  focus shows the news as one line of words, and a screen reader hears it. */
  let { message, skipMotion = false }: { message: Message; skipMotion?: boolean } = $props();

  const wake = $derived(pullRequestWatchWake(message.content));
  const summary = $derived.by(() => {
    if (!wake) return "";
    const words = pullRequestWatchWakeSummary(wake);
    return `#${wake.number}${words ? ` · ${words}` : ""}`;
  });
  const tooltip = $derived(wake ? `Pull request #${wake.number}: ${pullRequestWatchWakeSummary(wake) || "update"}` : "");
  const wakeMarks = $derived(wake ? pullRequestWatchWakeMarks(wake) : []);

  const MARK_ICON = {
    "checks-failed": FailedIcon,
    "checks-passed": PassedIcon,
    "all-checks-passed": AllPassedIcon,
    "no-checks": NoChecksIcon,
    remarks: RemarksIcon,
    conflicting: ConflictIcon,
    closed: ClosedIcon,
    stopped: StoppedIcon,
  };
  const TONE_CLASS = {
    failing: "text-red-500 dark:text-red-400",
    passing: "text-emerald-600 dark:text-emerald-300/90",
    pending: "text-amber-600 dark:text-amber-400/90",
    review: "text-violet-600 dark:text-violet-400",
    quiet: "",
  };
</script>

<HostNoticeRow
  {message}
  label="Pull request watch"
  {summary}
  {tooltip}
  attention={wake?.attention ?? false}
  {skipMotion}
  testid="pull-request-watch-row"
>
  {#snippet glyph()}
    {#if wake?.attention}
      <AlertIcon size={11} aria-hidden="true" />
    {:else}
      <EyeIcon size={11} aria-hidden="true" />
    {/if}
  {/snippet}
  {#snippet marks()}
    <span class="sr-only">{summary}</span>
    <span class="inline-flex items-center gap-2.5 align-middle tabular-nums" aria-hidden="true">
      <span>#{wake?.number}</span>
      {#each wakeMarks as mark (mark.kind)}
        {@const Icon = MARK_ICON[mark.kind]}
        <span class="inline-flex items-center gap-1" data-mark={mark.kind}>
          <Icon size={12} strokeWidth={2.25} class="shrink-0 {TONE_CLASS[mark.tone]}" />
          {#if mark.figure}<span>{mark.figure}</span>{/if}
        </span>
      {/each}
    </span>
  {/snippet}
</HostNoticeRow>
