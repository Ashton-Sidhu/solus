<script lang="ts">
  import type { SessionArtifact } from "@solus/contracts/session-artifacts";
  import type { ArtifactChipSize } from "@solus/contracts/settings";
  import { cardChips } from "@solus/client-core/session-artifact-chips";
  import { artifactKey } from "../../../contexts/sessions/session-artifacts";
  import { artifactTooltip } from "../../session/artifacts/lib/artifact-list";
  import ArtifactChip from "./ArtifactChip.svelte";

  /**
   * What one session linked, under its card: a chip per item, newest first.
   * The row wraps rather than scrolls, and stops at a few chips; `+N` opens the
   * session's Artifacts surface, which lists the rest.
   */
  interface Props {
    items: readonly SessionArtifact[];
    onOpen: (artifact: SessionArtifact) => void;
    onOpenAll: () => void;
    size?: ArtifactChipSize;
  }
  let { items, onOpen, onOpenAll, size = "small" }: Props = $props();

  const chips = $derived(cardChips(items));
</script>

<div class="flex min-w-0 flex-wrap {size === 'small' ? 'gap-1' : 'gap-1.5'}" data-testid="agent-card-artifacts">
  {#each chips.shown as chip (artifactKey(chip.artifact))}
    <ArtifactChip
      tone={chip.tone}
      label={chip.label}
      note={chip.note}
      pullRequestState={chip.pullRequestState}
      workType={chip.artifact.kind === "work" ? chip.artifact.workType : undefined}
      filePath={chip.artifact.kind === "file" || chip.artifact.kind === "image" ? chip.artifact.path : undefined}
      title={artifactTooltip(chip.artifact)}
      {size}
      onclick={() => onOpen(chip.artifact)}
    />
  {/each}
  {#if chips.hiddenCount > 0}
    <button
      type="button"
      class="inline-flex shrink-0 cursor-pointer items-center rounded-full border-0 bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] leading-[1.35] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-accent-border-medium) {size ===
    'small'
      ? 'h-5 px-2 text-[0.6875rem] pointer-coarse:h-7'
      : size === 'medium'
        ? 'h-6 px-2.5 text-xs pointer-coarse:h-8'
        : 'h-7 px-3 text-[0.8125rem] pointer-coarse:h-9'}"
      aria-label="Show all {items.length} linked items"
      title="Show all {items.length}"
      onclick={onOpenAll}
    >
      +{chips.hiddenCount}
    </button>
  {/if}
</div>
