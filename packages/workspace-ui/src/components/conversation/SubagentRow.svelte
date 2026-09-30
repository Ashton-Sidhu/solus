<script lang="ts">
  import { Check as CheckIcon, CircleAlert as WarningCircleIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { subagentRail, subagentTargetPath } from "./lib/subagent-card";
  import type { SubagentRow } from "./lib/subagent-group";
  import TranscriptCardRow from "./TranscriptCardRow.svelte";
  import SubagentIdentity from "./SubagentIdentity.svelte";

  /**
   * §18 — one row per agent in a fan-out. What varies between agents lives
   * here: the step in flight, progress, and elapsed time. Clicking a row opens
   * that agent's transcript in the pane.
   */
  interface Props {
    row: SubagentRow;
    tabId: string;
  }
  let { row, tabId }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  const railText = $derived(subagentRail(row));
  const isOpen = $derived(
    router.overlay?.name === "subagent" && router.overlay.params.messageId === row.id,
  );
</script>

{#snippet glyph()}
  {#if row.state === "running"}
    <span class="activity-spinner"></span>
  {:else if row.state === "failed"}
    <WarningCircleIcon />
  {:else}
    <CheckIcon />
  {/if}
{/snippet}

{#snippet rail()}
  <SubagentIdentity provider={row.provider} modelLabel={row.modelLabel} effortLabel={row.effortLabel} />
  {#if railText}<span>{railText}</span>{/if}
{/snippet}

<TranscriptCardRow
  name={row.name}
  activity={row.activity}
  isLive={row.state === "running"}
  target={row.target ? subagentTargetPath(row.target) : undefined}
  open={isOpen}
  glyphClass={row.state === "done" ? "is-done" : row.state === "failed" ? "is-failed" : ""}
  ariaLabel={`${row.name}, ${row.activity}`}
  data-testid="subagent-card"
  data-state={row.state}
  onOpen={() => session.openSubagent(tabId, row.id)}
  {glyph}
  {rail}
/>
