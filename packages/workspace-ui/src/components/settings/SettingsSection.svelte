<script lang="ts">
  /** A settings group: uppercase micro-label above a rounded card of rows.
   *  Renders nothing when `visible` is false, so a group whose rows are all
   *  filtered out by search disappears instead of leaving an empty card. */
  import type { Snippet } from "svelte";

  interface Props {
    label?: string;
    visible?: boolean;
    /** Leads the label — a brand mark for a group that names a product. */
    icon?: Snippet;
    /** Sits opposite the label — the group's own verb ("Add host", "Scan again"). */
    action?: Snippet;
    children: Snippet;
  }

  let { label, visible = true, icon, action, children }: Props = $props();
</script>

{#if visible}
  <section class="flex flex-col gap-2 [.is-laptop-display_&]:gap-1.5">
    {#if label || icon || action}
      <div class="flex min-h-6 items-center justify-between gap-3 px-0.5 [.is-laptop-display_&]:min-h-5">
        <div class="flex min-w-0 items-center gap-1.5">
          {#if icon}
            <span class="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
              {@render icon()}
            </span>
          {/if}
          <h2
            class="truncate text-[0.875em] font-medium uppercase text-muted-foreground"
          >
            {label}
          </h2>
        </div>
        {@render action?.()}
      </div>
    {/if}
    <div class="overflow-hidden rounded-2xl border border-border bg-card shadow-xs [.is-laptop-display_&]:rounded-xl">
      {@render children()}
    </div>
  </section>
{/if}
