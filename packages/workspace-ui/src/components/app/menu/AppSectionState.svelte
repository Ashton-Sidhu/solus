<script lang="ts">
  import type { Snippet } from "svelte";
  import { Button } from "../../ui/button";

  /**
   * What a list of the app menu says before it has rows: it loads, the read
   * failed, or the list is empty. With rows it draws them.
   */
  interface Props {
    /** Undefined until the host answers. */
    count: number | undefined;
    error: string | null;
    /** One line for a list with no rows. */
    empty: string;
    onRetry: () => void;
    children: Snippet;
  }
  let { count, error, empty, onRetry, children }: Props = $props();
</script>

{#if count === undefined}
  {#if error}
    <div class="flex flex-wrap items-center gap-2" role="alert">
      <span class="text-sm text-destructive">{error}</span>
      <Button size="xs" variant="outline" onclick={onRetry}>Try again</Button>
    </div>
  {:else}
    <p class="m-0 text-sm text-muted-foreground" role="status" aria-busy="true">Loading…</p>
  {/if}
{:else if count === 0}
  <p class="m-0 text-sm text-muted-foreground">{empty}</p>
{:else}
  {@render children()}
{/if}
