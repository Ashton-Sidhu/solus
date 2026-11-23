<script lang="ts">
  import { GitMergeIcon, GitPullRequestIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon } from "../ui/octicons";
  import { statusLabel, statusPillColors } from "./lib/pr-status";

  /**
   * What state this pull request is in, stated in its subtitle beside the author
   * and the branch — the way a code host states it — rather than as a speck in
   * the chrome band, where it was too small to read and sat away from the facts
   * it belongs with.
   *
   * The mark and the tone are the session sidebar's PR chip, so one pull request
   * reads identically wherever it surfaces.
   */
  let { status }: { status: string } = $props();

  const tone = $derived(statusPillColors(status));
  const StatusIcon = $derived(
    status === "merged" ? GitMergeIcon
      : status === "closed" ? GitPullRequestClosedIcon
      : status === "draft" ? GitPullRequestDraftIcon
      : GitPullRequestIcon,
  );
</script>

<span
  class="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap"
  style="background:{tone.background};color:{tone.color}"
>
  <StatusIcon size={12} class="shrink-0" />
  {statusLabel(status)}
</span>
