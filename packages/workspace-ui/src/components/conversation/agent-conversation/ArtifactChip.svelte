<script lang="ts">
  import {
    AppWindow as ArtifactIcon,
    File as FileIcon,
    FileText as DocIcon,
    GitPullRequest as GitPullRequestIcon,
    Image as ImageIcon,
    Network as DiagramIcon,
    Presentation as SlidesIcon,
    Workflow as AutomationIcon,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import type { WorkType } from "@solus/contracts/types";
  import type { ArtifactChipTone, PullRequestChipState } from "@solus/client-core/session-artifact-chips";
  import { prStatusBadge } from "../../prs/lib/pr-utils";

  /**
   * One thing a session linked, as a chip on its card, or one kind's total on
   * a folded group. The tint is the type; a pull request's chip is plain and
   * its icon takes the colour of its state, as the PR list draws it.
   */
  interface Props {
    tone: ArtifactChipTone;
    label: string;
    /** Muted text after the label: a pull request's state. */
    note?: string | null;
    pullRequestState?: PullRequestChipState | null;
    /** A work's own icon; a total of several works shows the tone's. */
    workType?: WorkType;
    /** The full name, when the label is cut. */
    title?: string;
    onclick: () => void;
  }
  let { tone, label, note = null, pullRequestState = null, workType, title, onclick }: Props = $props();

  // Works keep the WorkspaceCard hues apart from files: teal is written, purple
  // drawn. Amber and sage are left out; they mean "needs you" and "done".
  const HUE = {
    "pull-request": "var(--muted-foreground)",
    written: "var(--solus-art-4)",
    drawn: "var(--solus-art-6)",
    file: "var(--solus-art-5)",
    image: "var(--solus-art-1)",
    automation: "var(--solus-accent)",
  } satisfies Record<ArtifactChipTone, string>;

  const WORK_ICONS = {
    doc: DocIcon,
    slides: SlidesIcon,
    diagram: DiagramIcon,
    artifact: ArtifactIcon,
  } satisfies Record<WorkType, Component>;

  const badge = $derived(
    pullRequestState === "open" || pullRequestState === "draft"
      ? prStatusBadge({ state: "open", draft: pullRequestState === "draft" })
      : pullRequestState === "merged" || pullRequestState === "closed"
        ? prStatusBadge({ state: pullRequestState, draft: false })
        : null,
  );

  const Icon = $derived(
    tone === "pull-request"
      ? (badge?.Icon ?? GitPullRequestIcon)
      : tone === "written" || tone === "drawn"
        ? WORK_ICONS[workType ?? (tone === "written" ? "doc" : "diagram")]
        : tone === "file"
          ? FileIcon
          : tone === "image"
            ? ImageIcon
            : AutomationIcon,
  );
</script>

<button
  type="button"
  class="inline-flex h-5 max-w-[min(12rem,100%)] min-w-0 cursor-pointer overflow-hidden items-center gap-1 rounded-full border-0 pr-2 pl-1.5 text-transcript-meta leading-none font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-7 {tone ===
  'pull-request'
    ? 'bg-background text-(--solus-text-primary) shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_16%,transparent)] hover:bg-[color-mix(in_oklch,var(--foreground)_4%,var(--background))]'
    : 'bg-[color-mix(in_oklch,var(--chip-hue)_14%,transparent)] text-[color-mix(in_oklch,var(--chip-hue)_72%,var(--foreground))] hover:bg-[color-mix(in_oklch,var(--chip-hue)_22%,transparent)]'}"
  style:--chip-hue={HUE[tone]}
  title={title ?? label}
  {onclick}
>
  <Icon
    size={12}
    strokeWidth={1.75}
    aria-hidden="true"
    class="shrink-0"
    style={tone === "pull-request" ? `color:${badge?.tone ?? "var(--solus-text-tertiary)"}` : undefined}
  />
  <span class="min-w-0 truncate">{label}</span>
  {#if note}
    <span class="shrink-0 font-normal text-muted-foreground">{note}</span>
  {/if}
</button>
