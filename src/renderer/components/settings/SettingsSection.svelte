<script lang="ts">
  /** A settings group: uppercase micro-label above a rounded card of rows.
   *  Renders nothing when `visible` is false, so a group whose rows are all
   *  filtered out by search disappears instead of leaving an empty card. */
  import type { Snippet } from "svelte";

  interface Props {
    label?: string;
    visible?: boolean;
    /** Sits opposite the label — the group's own verb ("Add host", "Scan again"). */
    action?: Snippet;
    children: Snippet;
  }

  let { label, visible = true, action, children }: Props = $props();
</script>

{#if visible}
  <section class="flex flex-col gap-2">
    {#if label || action}
      <div class="flex min-h-6 items-center justify-between gap-3 px-0.5">
        <h2
          class="text-xs font-medium uppercase r text-muted-foreground"
        >
          {label}
        </h2>
        {@render action?.()}
      </div>
    {/if}
    <div class="overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
      {@render children()}
    </div>
  </section>
{/if}
