<script lang="ts">
  import DotMatrix from "../ui/DotMatrix.svelte";
  import TaskStatusGlyph from "../session/TaskStatusGlyph.svelte";
  import { formatResetClock } from "../../lib/sessionUtils";
  import type { AgentStateMark } from "./lib/agent-link";

  /**
   * An agent row's state mark, with the sidebar's grammar
   * (docs/plans/session-state-marks.md): dots that move while the agent works,
   * a still line glyph when a person must act or the agent is done.
   */
  interface Props {
    mark: AgentStateMark;
    /** The full sentence, for assistive technology. */
    label: string;
  }
  let { mark, label }: Props = $props();
  const glyphLabel = $derived(
    mark.kind === "glyph" && mark.status === "limit" && mark.limitResetsAt
      ? `${label}, resets ${formatResetClock(mark.limitResetsAt)}`
      : label,
  );
</script>

<span class="inline-flex size-4 shrink-0 items-center justify-center" title={glyphLabel}>
  {#if mark.kind === "dot"}
    <span class="flex items-center {mark.mark === 'offline' ? 'text-muted-foreground' : 'text-(--solus-status-working)'}">
      <DotMatrix mark={mark.mark} size={14} {label} />
    </span>
  {:else}
    <!-- The circle's stroke spans about 14px in a 15px Lucide glyph. -->
    <TaskStatusGlyph status={mark.status} label={glyphLabel} size={15} showsWord={false} />
  {/if}
</span>
