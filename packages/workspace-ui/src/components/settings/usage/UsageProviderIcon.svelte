<script lang="ts">
  import type { AgentId } from "@solus/contracts/types";
  import { Code as CodeIcon } from "@lucide/svelte";
  import ClaudeIcon from "../../ClaudeIcon.svelte";
  import OpenAIBlossom from "../../pickers/OpenAIBlossom.svelte";
  import ProviderMark from "../../ui/ProviderMark.svelte";

  interface Props {
    provider: AgentId;
    size?: number;
  }

  let { provider, size = 18 }: Props = $props();
</script>

{#if provider === "claude-code"}
  <span class="flex shrink-0 items-center text-(--solus-accent)" aria-hidden="true">
    <ClaudeIcon {size} />
  </span>
{:else if provider === "codex"}
  <span class="flex shrink-0 items-center text-foreground" aria-hidden="true">
    <OpenAIBlossom {size} fill="currentColor" />
  </span>
{:else if provider === "antigravity"}
  <ProviderMark mark="antigravity" {size} transparent />
{:else}
  <CodeIcon {size} class="shrink-0 text-muted-foreground" aria-hidden="true" />
{/if}
