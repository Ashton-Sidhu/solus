<script lang="ts">
  /**
   * The CLI copies of one MCP server that the person's runs left out
   * (docs/plans/mcp-first-class.md §8.5): one line for each, and where the skip
   * applies. The host reports them in the server's facts after a run.
   */
  import type { IntegrationCliSkip } from "@solus/contracts/integration-types";
  import { CLI_SKIP_NOTE, cliSkipLines } from "@solus/client-core/mcp-cli-skips";

  let { skips }: { skips: IntegrationCliSkip[] } = $props();

  const lines = $derived(cliSkipLines(skips));
</script>

<div class="flex flex-col gap-1 py-1.5" data-testid="integration-cli-skips">
  {#each lines as line (line)}
    <p class="break-words text-workspace-chrome text-foreground">{line}</p>
  {/each}
  <p class="text-pretty text-chrome-dense text-(--solus-text-tertiary)">{CLI_SKIP_NOTE}</p>
</div>
