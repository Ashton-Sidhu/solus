<script lang="ts">
  /**
   * What the one field of Add server reads as (docs/integrations.md): a
   * server's URL, or a command the host starts. It sits at the end of the
   * field, so the person sees the choice Solus made before they continue.
   */
  import { Globe, SquareTerminal } from "@lucide/svelte";

  let { kind }: { kind: "url" | "command" } = $props();
</script>

<span data-testid="mcp-source-kind" class="pointer-events-none absolute inset-y-0 right-1.5 flex items-center">
  <span class="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-sans text-chrome-dense text-(--solus-text-secondary)">
    {#if kind === "url"}<Globe size={12} />Server URL{:else}<SquareTerminal size={12} />Command{/if}
  </span>
</span>
