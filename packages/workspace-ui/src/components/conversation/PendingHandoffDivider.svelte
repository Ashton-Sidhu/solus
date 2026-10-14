<script lang="ts">
  import { modelLabelFor, type Session } from "@solus/contracts/types";
  import { agentLabel } from "../../lib/agentAvailability";
  import TranscriptDivider from "./TranscriptDivider.svelte";
  import { pendingHandoffProvider } from "./lib/pending-handoff";

  /**
   * The composer picked another agent than the one holding the thread
   * (plans/021). Nothing has happened on the host yet: the next send hands the
   * thread over, and the host's `agent_switched` divider takes this row's place.
   */
  interface Props {
    session: Session;
  }
  let { session }: Props = $props();

  const pickedProvider = $derived(pendingHandoffProvider(session));
  const pickedLabel = $derived(
    pickedProvider
      ? modelLabelFor(pickedProvider, session.run.modelConfig.modelId) ?? agentLabel(pickedProvider)
      : "",
  );
</script>

{#if pickedProvider}
  <TranscriptDivider testid="handoff-pending-message">
    Context handoff pending
    {#snippet title()}<span class="text-(--solus-accent)">{pickedLabel}</span>{/snippet}
  </TranscriptDivider>
{/if}
