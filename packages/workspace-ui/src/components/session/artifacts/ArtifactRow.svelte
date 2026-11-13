<script lang="ts">
  import FileIcon from "../../ui/file-icon/FileIcon.svelte";
  import {
    AppWindow as HtmlArtifactIcon,
    LayoutGrid as AppIcon,
    CircleAlert as MissingIcon,
    FileText as DocumentIcon,
    GitMerge as MergedIcon,
    GitPullRequest as PullRequestIcon,
    GitPullRequestClosed as ClosedIcon,
    GitPullRequestDraft as DraftIcon,
    Presentation as SlidesIcon,
    Workflow as AutomationIcon,
  } from "@lucide/svelte";
  import type { SessionArtifact } from "@solus/contracts/session-artifacts";
  import { artifactLinkedAt } from "../../../contexts/sessions/session-artifacts";
  import { highlightRuns } from "../../../lib/searchHighlight";
  import { formatGeneratedFull, formatLedgerTime } from "../../workspace/lib/workspace-items";
  import { artifactDetail, artifactIconLabel, artifactTitle, artifactTooltip, pullRequestState } from "./lib/artifact-list";

  /**
   * One artifact as a list row. The icon says what it is and where it stands —
   * a work's type, a pull request's state — so the row spends no words on it.
   */
  interface Props {
    artifact: SessionArtifact;
    query: string;
    /** The artifact the session linked last, which takes a short wash. */
    highlighted: boolean;
    onOpen: () => void;
  }
  let { artifact, query, highlighted, onOpen }: Props = $props();

  const titleRuns = $derived(highlightRuns(artifactTitle(artifact), query));
  const detail = $derived(artifactDetail(artifact));
  const linkedAt = $derived(artifactLinkedAt(artifact));
  const iconLabel = $derived(artifactIconLabel(artifact));
  const prState = $derived(artifact.kind === "pull-request" ? (pullRequestState(artifact.link) ?? "unknown") : null);

  const WORK_ICONS = { doc: DocumentIcon, slides: SlidesIcon, artifact: HtmlArtifactIcon };
  const PR_ICONS = {
    open: PullRequestIcon,
    draft: DraftIcon,
    merged: MergedIcon,
    closed: ClosedIcon,
    missing: MissingIcon,
    unknown: PullRequestIcon,
  };

  // The Workspace page's hues for works (teal written, dusty blue drawn) and
  // the pull request list's state tones.
  const WORK_ICON_COLOR = {
    doc: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    slides: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    artifact: "text-[color-mix(in_oklch,var(--chart-5)_66%,var(--foreground))]",
  };
  const PR_ICON_COLOR = {
    open: "text-emerald-600 dark:text-emerald-300/90",
    draft: "text-zinc-500 dark:text-zinc-400/80",
    merged: "text-violet-600 dark:text-violet-300/90",
    closed: "text-red-600 dark:text-red-300/90",
    missing: "text-amber-600 dark:text-amber-400/90",
    unknown: "text-muted-foreground",
  };
</script>

<button
  type="button"
  title={artifactTooltip(artifact)}
  class="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-left text-workspace-chrome text-foreground hover:bg-[var(--wash-2)] pointer-coarse:h-11 focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] {highlighted
    ? 'transition-colors duration-[1400ms] ease-out starting:bg-(--solus-accent)/20 motion-reduce:transition-none'
    : 'transition-colors duration-150'}"
  onclick={onOpen}
>
  <span
    class="flex size-4 shrink-0 items-center justify-center {prState
      ? PR_ICON_COLOR[prState]
      : artifact.kind === 'work'
        ? WORK_ICON_COLOR[artifact.workType]
        : artifact.kind === 'app'
          ? 'text-[color-mix(in_oklab,var(--solus-art-7)_66%,var(--foreground))]'
          : 'text-muted-foreground'}"
    role="img"
    aria-label={iconLabel}
    title={iconLabel}
  >
    {#if prState}
      {@const Icon = PR_ICONS[prState]}
      <Icon size={16} strokeWidth={1.75} />
    {:else if artifact.kind === "work"}
      {@const Icon = WORK_ICONS[artifact.workType]}
      <Icon size={16} strokeWidth={1.75} />
    {:else if artifact.kind === "file" || artifact.kind === "image"}
      <FileIcon path={artifact.path} size={16} />
    {:else if artifact.kind === "automation"}
      <AutomationIcon size={16} strokeWidth={1.75} />
    {:else if artifact.kind === "app"}
      <AppIcon size={16} strokeWidth={1.75} />
    {/if}
  </span>
  <span class="flex min-w-0 flex-1 items-baseline gap-2">
    <span class="min-w-0 shrink truncate">
      {#each titleRuns as run, i (i)}{#if run.hit}<mark class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit">{run.text}</mark>{:else}{run.text}{/if}{/each}
    </span>
    {#if detail}
      <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{detail}</span>
    {/if}
  </span>
  <span class="shrink-0 text-xs tabular-nums text-muted-foreground" title="Linked {formatGeneratedFull(linkedAt)}">
    {formatLedgerTime(linkedAt)}
  </span>
</button>
