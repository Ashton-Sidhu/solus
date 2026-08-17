<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import { portal } from "../portal";

  // Stands in for PlanModal from the moment the plan surface opens until the
  // plan's content has been read off disk and the modal's own chunk has loaded.
  // It mirrors DocumentShell's geometry — the 46px header, the outline rail,
  // and the reading measure with the comment margin reserved — off the same
  // variables the real column uses, so the prose lands in the same place when
  // the shell swaps in.

  interface Props {
    /** Full-pane (editor mode) vs floating modal + backdrop (pill mode). */
    inline?: boolean;
  }

  let { inline = false }: Props = $props();

  // Fixed widths, not random ones: the placeholder must not reshuffle on a
  // re-render while the read is still in flight.
  const SECTIONS = [
    { heading: 44, lines: [97, 88, 71] },
    { heading: 33, lines: [93, 98, 82, 63] },
    { heading: 51, lines: [90, 95, 74] },
  ];
  const RAIL_TICKS = [74, 55, 64, 46, 59, 41];
</script>

{#snippet shellInner()}
  <div
    class="relative flex flex-col overflow-hidden bg-(--solus-container-bg) @container {inline
 ? 'h-full'
 : 'h-[min(86vh,90vh)] w-[min(100rem,96vw)] rounded-2xl border border-(--solus-tool-border) shadow-[shadow:var(--solus-popover-shadow)]'}"
    role="status"
    aria-label="Loading plan"
  >
    <!-- The title is known before the content is, so it stays real type; only
         the verbs on the right are ghosts. -->
    <header class="workspace-titlebar flex h-[2.875rem] shrink-0 items-center pl-[1.375rem]">
      <span class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
        Review Plan
      </span>
      <div class="min-w-4 flex-auto"></div>
      <div
        class="flex shrink-0 items-center gap-0.75 pr-[max(0.875rem,var(--solus-pane-chrome-inset,3.25rem))]"
        aria-hidden="true"
      >
        <Skeleton class="h-7 w-[4.75rem] rounded-lg" />
        <Skeleton class="h-7 w-[6rem] rounded-lg" />
        <Skeleton class="size-7 rounded-lg" />
        <Skeleton class="size-7 rounded-lg" />
      </div>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- Ghost outline ticks, folding at the same container width as the real rail. -->
      <div
        class="ml-3 shrink-0 grow-0 basis-22 pt-10 pr-3.5 pb-8 @max-[45rem]:hidden @min-[90rem]:basis-38"
        aria-hidden="true"
      >
        <div class="flex flex-col gap-3">
          {#each RAIL_TICKS as tick, i (i)}
            <Skeleton
              class="h-1.5 rounded-full opacity-60"
              style="width:{tick}%;animation-delay:{i * 70}ms"
            />
          {/each}
        </div>
      </div>

      <div class="plan-skeleton-column flex min-w-0 flex-1 flex-col">
        <!-- Nothing scrolls yet: a placeholder that can be scrolled away from
             would leave the real document scrolled somewhere arbitrary. The
             gutter is still reserved, like the real scroll region's. -->
        <div class="min-h-0 flex-1 overflow-hidden [scrollbar-gutter:stable]">
          <div class="plan-skeleton-page">
            <div class="plan-skeleton-prose min-w-0 flex-1" aria-hidden="true">
              <Skeleton class="rounded-lg" style="height:2.53em;width:62%" />
              <!-- The byline the real h1 hangs off. -->
              <div class="flex items-center gap-2" style="margin:0.42em 0 1.9em">
                <Skeleton class="rounded-full opacity-55" style="height:0.72em;width:5.5em" />
                <Skeleton class="rounded-full opacity-55" style="height:0.72em;width:4em" />
              </div>
              {#each SECTIONS as section, s (s)}
                <Skeleton
                  class="rounded-md"
                  style="height:1.63em;width:{section.heading}%;margin:1.9em 0 0.55em"
                />
                <div class="flex flex-col" style="gap:1.02em">
                  {#each section.lines as line, l (l)}
                    <Skeleton
                      class="rounded-sm opacity-80"
                      style="height:0.7em;width:{line}%;animation-delay:{s * 90 + l * 60}ms"
                    />
                  {/each}
                </div>
              {/each}
            </div>
          </div>
        </div>

        <!-- Action bar: the composer's own chrome is drawn for real, so only
             its controls fade in when the plan arrives. -->
        <div class="shrink-0 px-3 pt-2 pb-2 md:px-0 md:pb-3">
          <div
            class="plan-skeleton-composer flex min-h-[5.5rem] flex-col rounded-[1.375rem] border bg-(--solus-input-pill-bg) px-3.5 pt-1 pb-2"
            aria-hidden="true"
          >
            <div class="flex flex-1 items-center px-1">
              <Skeleton class="h-3 w-40 rounded-sm opacity-55" />
            </div>
            <div class="flex items-center gap-1">
              <Skeleton class="h-7 w-28 rounded-full opacity-70" />
              <Skeleton class="size-7 rounded-full opacity-70" />
              <div class="ml-auto flex items-center gap-1.5">
                <Skeleton class="h-7 w-[4.5rem] rounded-lg opacity-70" />
                <Skeleton class="h-7 w-[5.5rem] rounded-lg opacity-70" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
{/snippet}

{#if inline}
  {@render shellInner()}
{:else}
  <div
    use:portal={document.body}
    class="plan-skeleton-backdrop fixed inset-0 z-[10000] flex items-center justify-center"
    role="presentation"
  >
    {@render shellInner()}
  </div>
{/if}

<style>
  /* The measure ladder and the comment margin, copied off the real doc column
     (index.css / PlanModal.css) rather than approximated — both are `cqi` on
     the shell container, which is what makes a split pane narrow the column
     instead of the window doing it. */
  .plan-skeleton-column {
    --solus-doc-size: calc(0.875rem * var(--solus-font-scale, 1));
    --solus-doc-measure: clamp(66ch, 68cqi, 112ch);
    --solus-doc-rail-w: clamp(13.5rem, 26cqi, 18rem);
  }
  .plan-skeleton-page {
    display: flex;
    align-items: flex-start;
    width: min(100%, calc(var(--solus-doc-measure) + 7rem + var(--solus-doc-rail-w)));
    margin-inline: auto;
  }
  /* Type-relative, like the document it stands in for: every bar in the markup
     is sized in `em` off the body size, so the placeholder rescales with the
     column instead of drifting out of step with it. */
  .plan-skeleton-prose {
    --doc-pad-x: 3.5rem;
    max-width: calc(var(--solus-doc-measure) + 2 * var(--doc-pad-x));
    margin-inline: auto;
    padding: 2.75rem var(--doc-pad-x) 4rem;
    font-size: var(--solus-doc-size);
  }
  /* The composer lines up under the text column, same as the real action bar. */
  .plan-skeleton-composer {
    max-width: min(var(--solus-doc-measure), calc(100% - 2.5rem));
    margin-inline: auto;
  }
  .plan-skeleton-backdrop {
    background: radial-gradient(
      circle at 50% 38%,
      color-mix(in srgb, var(--solus-modal-scrim) 82%, transparent) 0%,
      var(--solus-modal-scrim) 72%
    );
  }

  /* The same pane-width ladder the real column steps down, so the swap is a
     fade rather than a reflow at every width. */
  @container (max-width: 73.75rem) {
    .plan-skeleton-prose {
      --doc-pad-x: 2.5rem;
    }
  }
  @container (max-width: 56.25rem) {
    .plan-skeleton-prose {
      --doc-pad-x: 1.75rem;
    }
  }
  @container (max-width: 45rem) {
    .plan-skeleton-column {
      --solus-doc-size: calc(0.875rem * var(--solus-font-scale, 1));
    }
    .plan-skeleton-prose {
      --doc-pad-x: 1.375rem;
    }
  }
  @media (max-width: 767px) {
    .plan-skeleton-column {
      --solus-doc-size: calc(0.875rem * var(--solus-font-scale, 1));
    }
    .plan-skeleton-prose {
      padding-top: 1.25rem;
    }
  }
</style>
