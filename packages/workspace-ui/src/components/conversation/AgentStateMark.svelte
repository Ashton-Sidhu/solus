<script lang="ts">
  import DotMatrix from "../ui/DotMatrix.svelte";
  import TaskStatusGlyph from "../session/TaskStatusGlyph.svelte";
  import type { AgentStateMark } from "./lib/agent-link";

  /**
   * An agent row's state mark, with the sidebar's grammar
   * (docs/plans/session-state-marks.md): dots that move while the agent works,
   * a still line glyph when a person must act or the agent is done. Input,
   * Approval, and Limited say their word; Limited adds its reset time.
   */
  interface Props {
    mark: AgentStateMark;
    /** The full sentence, for assistive technology. */
    label: string;
  }
  let { mark, label }: Props = $props();
</script>

{#if mark.kind === "dot"}
  <!-- The running tone of the sidebar's dots; offline is muted, as its state can be old. -->
  <span class="flex shrink-0 items-center {mark.mark === 'offline' ? 'text-muted-foreground' : 'text-chart-5'}">
    <DotMatrix mark={mark.mark} {label} />
  </span>
{:else}
  <TaskStatusGlyph status={mark.status} {label} size={13} limitResetsAt={mark.limitResetsAt ?? null} />
{/if}
