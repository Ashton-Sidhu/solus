<script lang="ts">
  import type { AgentId } from "@solus/contracts/types";
  import ClaudeIcon from "../ClaudeIcon.svelte";
  import OpenAIBlossom from "../pickers/OpenAIBlossom.svelte";

  /**
   * Which backend and model a sub-agent runs on, as the first item of its rail:
   * the provider's mark and the model's name. Shared by the run card, the return
   * card, and the grouped rows, so the three read the same way.
   */
  interface Props {
    provider: AgentId;
    modelLabel: string;
    /** Reasoning effort. The sub-agent pane leaves it out, so the card shows it. */
    effortLabel: string;
  }
  let { provider, modelLabel, effortLabel }: Props = $props();
  const label = $derived([modelLabel, effortLabel].filter(Boolean).join(" · "));
</script>

<span class="inline-flex min-w-0 items-center gap-1" title={label}>
  {#if provider === "codex"}
    <OpenAIBlossom size={11} fill="currentColor" />
  {:else}
    <ClaudeIcon size={11} />
  {/if}
  <span class="sr-only">{provider === "codex" ? "Codex" : "Claude"}</span>
  {#if label}<span class="truncate">{label}</span>{/if}
</span>
