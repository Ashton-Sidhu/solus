<script lang="ts">
  /** One setting inside a `SettingsSection` card: a medium-weight title and a
   *  quiet one-line description on the left, the control at the trailing edge,
   *  with an optional full-width `body` below. Sixteen pixels in from the
   *  card's edge and twelve above and below; the card draws the hairline
   *  between rows. Under thirty rem of pane the control drops beneath the
   *  copy rather than squeezing it. */
  import type { Snippet } from "svelte";

  interface Props {
    label: string;
    description?: string;
    visible?: boolean;
    /** Inline badge rendered immediately after the label. */
    labelExtra?: Snippet;
    control?: Snippet;
    /** Full-width block below the label/control line. */
    body?: Snippet;
    /** Keep a supplied body mounted only when its owning setting needs it. */
    bodyVisible?: boolean;
    /**
     * A setting the layout already accounts for but nothing backs yet. Drawn
     * dimmed, badged, and inert in one place, so every placeholder in Solus
     * reads the same rather than each surface inventing its own apology.
     */
    comingSoon?: boolean;
    /** Hook for e2e selectors that need to scope into a single row. */
    testId?: string;
  }

  let {
    label,
    description,
    visible = true,
    labelExtra,
    control,
    body,
    bodyVisible = true,
    comingSoon = false,
    testId,
  }: Props = $props();
</script>

{#if visible}
  <div
    data-testid={testId}
    class="px-4 py-3 {comingSoon ? 'opacity-55' : ''}"
  >
    <div
      class="flex flex-col gap-3 @min-[30rem]/pane:grid @min-[30rem]/pane:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[30rem]/pane:items-center @min-[30rem]/pane:gap-8"
    >
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex min-h-5 items-center gap-1.5">
          <h3 class="text-sm font-medium tracking-[-0.005em] text-foreground">
            {label}{@render labelExtra?.()}
          </h3>
          {#if comingSoon}
            <span
              class="shrink-0 whitespace-nowrap rounded-full border border-border px-1.5 py-px text-[11px] leading-[1.5] font-medium uppercase tracking-[0.04em] text-muted-foreground"
            >
              Coming soon
            </span>
          {/if}
        </div>
        {#if description}
          <p class="max-w-xl text-pretty text-[13px] leading-[1.45] text-muted-foreground/80">
            {description}
          </p>
        {/if}
      </div>
      {#if control}
        <div
          class="flex w-full shrink-0 items-center gap-2 @min-[30rem]/pane:w-auto @min-[30rem]/pane:justify-end"
          inert={comingSoon}
        >
          {@render control()}
        </div>
      {/if}
    </div>
    {#if body && bodyVisible}
      <div class="mt-3">{@render body()}</div>
    {/if}
  </div>
{/if}
