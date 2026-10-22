<script lang="ts">
  import { Eye as EyeIcon, CircleAlert as AlertIcon } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import {
    pullRequestWatchWake,
    pullRequestWatchWakeSummary,
  } from "@solus/client-core/pull-request-watch-wake";
  import HostNoticeRow from "./HostNoticeRow.svelte";

  /** A pull request watch's wake as a host notice: an eye, the pull request,
   *  and its news in a few words — "#42 · checks failed, new comments". */
  let { message, skipMotion = false }: { message: Message; skipMotion?: boolean } = $props();

  const wake = $derived(pullRequestWatchWake(message.content));
  const summary = $derived.by(() => {
    if (!wake) return "";
    const words = pullRequestWatchWakeSummary(wake);
    return `#${wake.number}${words ? ` · ${words}` : ""}`;
  });
</script>

<HostNoticeRow
  {message}
  label="Pull request watch"
  {summary}
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
</HostNoticeRow>
