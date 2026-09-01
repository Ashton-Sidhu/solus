<script lang="ts">
  /**
   * A route's module failed to load. Every page surface is behind a dynamic
   * import, and a rejected import has no `{:catch}` of its own to fall into —
   * without this the pending skeleton stays on screen forever and reads as a
   * page that is still loading. A chunk fetch can fail for an ordinary reason
   * (the dev server restarted mid-navigation, the network dropped), so the way
   * out is another attempt rather than a reload of the whole app.
   */
  import { TriangleAlert as WarningIcon } from "@lucide/svelte";
  import PageEmpty from "./PageEmpty.svelte";
  import { Button } from "./button";

  let {
    error,
    onRetry,
    compact = false,
  }: {
    error: unknown;
    onRetry: () => void;
    compact?: boolean;
  } = $props();

  const detail = $derived(
    error instanceof Error ? error.message : String(error),
  );
</script>

<PageEmpty
  icon={WarningIcon}
  tone="muted"
  title="Couldn’t load this page."
  {compact}
>
  {detail}
  {#snippet actions()}
    <Button type="button" variant="outline" onclick={onRetry}>Try again</Button>
  {/snippet}
</PageEmpty>
