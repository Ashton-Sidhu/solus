<script lang="ts">
  import {
    AppWindow as HtmlArtifactIcon,
    File as FileIcon,
    FileText as DocumentIcon,
    GitPullRequest as PullRequestIcon,
    Image as ImageIcon,
    Network as DiagramIcon,
    Presentation as SlidesIcon,
    Workflow as AutomationIcon,
  } from "@lucide/svelte";
  import type { SessionArtifact } from "@solus/contracts/session-artifacts";
  import { artifactLinkedAt } from "../../../contexts/sessions/session-artifacts";
  import { highlightRuns } from "../../../lib/searchHighlight";
  import { formatGeneratedFull, formatLedgerTime } from "../../workspace/lib/workspace-items";
  import {
    artifactDetail,
    artifactKindLabel,
    artifactTitle,
    artifactTooltip,
    pullRequestState,
  } from "./lib/artifact-list";

  /**
   * One artifact as a card, drawn like the Workspace page's work cards: what
   * kind of thing it is and when it was linked, its name, and where it lives.
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
  const prState = $derived(artifact.kind === "pull-request" ? pullRequestState(artifact.link) : null);
  const linkedAt = $derived(artifactLinkedAt(artifact));

  const WORK_ICONS = {
    doc: DocumentIcon,
    slides: SlidesIcon,
    diagram: DiagramIcon,
    artifact: HtmlArtifactIcon,
  };

  const KIND_ICONS = {
    "pull-request": PullRequestIcon,
    file: FileIcon,
    image: ImageIcon,
    automation: AutomationIcon,
  };

  // The Workspace page's hues: teal for written works, dusty blue for drawn ones.
  const WORK_ICON_COLOR = {
    doc: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    slides: "text-[color-mix(in_oklch,var(--chart-4)_66%,var(--foreground))]",
    diagram: "text-[color-mix(in_oklch,var(--chart-5)_66%,var(--foreground))]",
    artifact: "text-[color-mix(in_oklch,var(--chart-5)_66%,var(--foreground))]",
  };

  const PR_STATE_DOT = {
    open: "bg-emerald-600 dark:bg-emerald-300/90",
    draft: "bg-zinc-400 dark:bg-zinc-500",
    merged: "bg-violet-600 dark:bg-violet-300/90",
    closed: "bg-red-600 dark:bg-red-300/90",
    missing: "bg-amber-500 dark:bg-amber-400/90",
  };
</script>

<!-- The Workspace card: a hairline edge and a faint drop at rest, a deeper
     shadow under the pointer. Shadow only, so a hover never moves the grid. -->
<button
  type="button"
  title={artifactTooltip(artifact)}
  class="group flex w-full min-w-0 cursor-pointer flex-col overflow-hidden gap-2 rounded-xl border-0 bg-card px-4 pt-3.5 pb-3 text-left text-xs shadow-[0_0_0_.5px_var(--hairline-strong),0_1px_2px_color-mix(in_oklch,var(--foreground)_4%,transparent)] select-none hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_20%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--foreground)_22%,transparent)] focus-visible:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_45%,transparent),0_6px_18px_-10px_color-mix(in_oklch,var(--primary)_40%,transparent)] focus-visible:outline-none {highlighted
    ? 'transition-[background-color,box-shadow] duration-[1400ms] ease-out starting:bg-(--solus-accent)/20 motion-reduce:transition-none'
    : 'transition-shadow duration-200'}"
  onclick={onOpen}
>
  <!-- Line 1: what kind of thing it is, and when the session linked it. -->
  <span class="flex h-4 w-full min-w-0 items-center gap-1.5 text-muted-foreground">
    <span class="flex shrink-0 items-center {artifact.kind === 'work' ? WORK_ICON_COLOR[artifact.workType] : ''}" aria-hidden="true">
      {#if artifact.kind === "work"}
        {@const Icon = WORK_ICONS[artifact.workType]}
        <Icon size={14} />
      {:else}
        {@const Icon = KIND_ICONS[artifact.kind]}
        <Icon size={14} />
      {/if}
    </span>
    <span class="truncate">{artifactKindLabel(artifact)}</span>
    {#if prState}
      <span class="flex shrink-0 items-center gap-1">
        <span class="size-1.5 rounded-full {PR_STATE_DOT[prState]}" aria-hidden="true"></span>
        {prState}
      </span>
    {/if}
    <span class="flex-1"></span>
    <span class="shrink-0 tabular-nums" title="Linked {formatGeneratedFull(linkedAt)}">{formatLedgerTime(linkedAt)}</span>
  </span>

  <span class="line-clamp-2 w-full text-workspace-chrome leading-[1.35] font-medium tracking-[-0.006em] text-pretty text-foreground">
    {#each titleRuns as run, i (i)}{#if run.hit}<mark class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)] px-px text-inherit">{run.text}</mark>{:else}{run.text}{/if}{/each}
  </span>

  <!-- Where it lives. A card without a place keeps the line's height, so the
       feet of a row of cards align. -->
  <span class="flex h-[18px] w-full min-w-0 items-center text-muted-foreground">
    {#if detail}
      <span class="min-w-0 truncate">{detail}</span>
    {/if}
  </span>
</button>
