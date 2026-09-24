<script lang="ts">
  import { CircleAlert as WarningCircleIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { runCardDetail, seamSegments, subagentRail } from "./lib/subagent-card";
  import type { SubagentRow } from "./lib/subagent-group";
  import TranscriptCard from "./TranscriptCard.svelte";
  import SubagentIdentity from "./SubagentIdentity.svelte";

  /**
   * §3a — a subagent while it runs, and when it dies. One card line: the task,
   * the step in flight as the type word, and the step meter as a seam along the
   * bottom edge, where a progress bar cannot be mistaken for content.
   *
   * State changes the glyph, the ring, and one segment. It never changes the
   * geometry, so a card that changes state does not reflow the thread.
   */
  interface Props {
    row: SubagentRow;
    tabId: string;
    skipMotion?: boolean;
  }
  let { row, tabId, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  const segments = $derived(seamSegments(row.steps, row.state));
  const detail = $derived(runCardDetail(row));
  const railText = $derived(subagentRail(row));
  const failed = $derived(row.state === "failed");
  const isOpen = $derived(
    router.overlay?.name === "subagent" && router.overlay.params.messageId === row.id,
  );
</script>

{#snippet glyph()}
  {#if failed}
    <WarningCircleIcon />
  {:else}
    <span class="activity-spinner" aria-hidden="true"></span>
  {/if}
{/snippet}

{#snippet rail()}
  <SubagentIdentity provider={row.provider} modelLabel={row.modelLabel} effortLabel={row.effortLabel} />
  {#if railText}<span>{railText}</span>{/if}
{/snippet}

<!-- Only a failure has something to read: the reason the agent stopped. -->
{#snippet failureReason()}
  <p class="m-0 text-muted-foreground text-pretty">{row.activity}</p>
{/snippet}

<!-- The seam is the meter: one segment per step of the agent's plan. It exists
     only when there is a plan to count against. -->
{#snippet seam()}
  {#each segments as segment, i (i)}
    <span
      class="flex-1 {segment === 'done'
        ? 'bg-[color-mix(in_oklch,var(--foreground)_36%,transparent)]'
        : segment === 'live'
          ? 'bg-(--primary)'
          : segment === 'failed'
            ? 'bg-[color-mix(in_oklch,var(--destructive)_45%,transparent)]'
            : 'bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)]'}"
    ></span>
  {/each}
{/snippet}

<TranscriptCard
  title={row.name}
  target={detail || undefined}
  open={isOpen}
  {failed}
  ariaLabel={`${row.name}, ${row.activity}`}
  glyphClass={failed ? "is-failed" : ""}
  onOpen={() => session.openSubagent(tabId, row.id)}
  data-testid="subagent-card"
  {skipMotion}
  {glyph}
  {rail}
  body={failed && row.activity ? failureReason : undefined}
  seam={segments.length > 0 ? seam : undefined}
/>
