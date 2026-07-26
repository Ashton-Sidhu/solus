<script lang="ts">
  /** A settings group: uppercase micro-label above a rounded card of rows.
   *  Renders nothing when `visible` is false, so a group whose rows are all
   *  filtered out by search disappears instead of leaving an empty card. */
  import type { Snippet } from "svelte";

  interface Props {
    label?: string;
    visible?: boolean;
    children: Snippet;
  }

  let { label, visible = true, children }: Props = $props();
</script>

{#if visible}
  <section class="flex flex-col gap-2">
    {#if label}
      <h2
        class="px-0.5 text-[0.625rem] font-medium uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </h2>
    {/if}
    <div class="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      {@render children()}
    </div>
  </section>
{/if}
