<script lang="ts">
  /** A settings group: a quiet sentence-case heading over a card of rows, a
   *  hairline between one row and the next. Renders nothing when `visible` is
   *  false, so a group whose rows are all filtered out by search disappears
   *  instead of leaving an empty card. */
  import type { Snippet } from "svelte";

  interface Props {
    label?: string;
    /** One muted sentence under the label that applies to every row in the card. */
    description?: string;
    visible?: boolean;
    /** Leads the label — a brand mark for a group that names a product. */
    icon?: Snippet;
    /** Sits opposite the label — the group's own verb ("Add host", "Scan again"). */
    action?: Snippet;
    /** No card: the children draw their own surfaces, as the theme tiles do. */
    plain?: boolean;
    children: Snippet;
  }

  let { label, description, visible = true, icon, action, plain = false, children }: Props = $props();
</script>

{#if visible}
  <section class="flex flex-col gap-2.5">
    {#if label || icon || action}
      <!-- The heading starts on the rows' text column, sixteen pixels in, so
           it reads as the group's name rather than a label floating above. -->
      <div class="flex min-h-7 items-start justify-between gap-4 px-4">
        <h2
          class="flex min-h-7 min-w-0 items-center gap-2 text-sm font-normal tracking-[-0.005em] text-foreground/70"
        >
          {#if icon}
            <span class="flex size-3.5 shrink-0 items-center justify-center">
              {@render icon()}
            </span>
          {/if}
          <span class="truncate">{label}</span>
        </h2>
        {#if action}
          <div class="flex min-h-7 shrink-0 items-center justify-end">{@render action?.()}</div>
        {/if}
      </div>
    {/if}
    {#if description}
      <p class="max-w-xl px-4 text-pretty text-[13px] leading-[1.45] text-muted-foreground/80">{description}</p>
    {/if}
    {#if plain}
      {@render children()}
    {:else}
      <div
        class="overflow-hidden rounded-xl border border-border/60 bg-card/40 text-foreground shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50"
      >
        {@render children()}
      </div>
    {/if}
  </section>
{/if}
