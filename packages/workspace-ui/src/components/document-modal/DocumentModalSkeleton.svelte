<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import { portal } from "../portal";
  import { workBreadcrumb } from "./lib/breadcrumb";
  import type { WorkStorage } from "@solus/contracts/types";

  // Stands in for DocumentModal from the moment a document work opens until the
  // modal's own chunk (Tiptap and all) has loaded. Same contract as
  // PlanModalSkeleton: it mirrors DocumentShell's geometry — the chrome-row header,
  // the outline rail, the reading measure with the comment margin reserved —
  // off the same variables the real column uses, so the prose lands in the same
  // place when the shell swaps in.

  interface Props {
    /** Full-pane (editor mode) vs floating modal + backdrop (pill mode). */
    inline?: boolean;
    /** Known before the content is, so it stays real type rather than a ghost. */
    title?: string;
    workStorage?: WorkStorage;
    /** The comment margin the real page reserves. "0px" where there are no
     *  comments (an ad-hoc preview), matching DocumentModal's own railWidth. */
    railWidth?: string;
  }

  let { inline = false, title, workStorage, railWidth = "18.8125rem" }: Props = $props();

  const breadcrumb = $derived(workBreadcrumb(workStorage));

  // Fixed widths, not random ones: the placeholder must not reshuffle on a
  // re-render while the chunk is still in flight.
  const SECTIONS = [
    { heading: 41, lines: [96, 89, 73] },
    { heading: 56, lines: [92, 97, 84, 66] },
    { heading: 35, lines: [91, 94, 78] },
  ];
  const RAIL_TICKS = [70, 58, 62, 44, 66, 49];
</script>

{#snippet shellInner()}
  <div
    class="relative flex flex-col overflow-hidden bg-(--solus-container-bg) @container {inline
 ? 'h-full'
 : 'h-[min(86vh,90vh)] w-[min(100rem,96vw)] rounded-2xl border border-(--solus-tool-border) shadow-[shadow:var(--solus-popover-shadow)]'}"
    role="status"
    aria-label="Loading document"
  >
    <!-- Where you are stays real type; only the verbs on the right are ghosts.
         Height and lead inset come off the same variables the real header uses,
         so nothing below it shifts when the shell swaps in. -->
    <header
      class="workspace-titlebar flex shrink-0 items-center gap-2.5 {inline
 ? 'h-(--solus-chrome-row-h,2.5rem) pl-[max(1.375rem,var(--solus-chrome-lead-inset,0px))]'
 : 'h-(--solus-chrome-row-h,2.5rem) pl-[1.375rem]'}"
    >
      {#if breadcrumb}
        <span class="doc-skeleton-breadcrumb">{breadcrumb} /</span>
      {/if}
      {#if title}
        <span
          class="min-w-0 truncate text-workspace-chrome font-medium text-(--solus-text-primary)"
        >
          {title}
        </span>
      {:else}
        <Skeleton class="h-3 w-40 rounded-sm" />
      {/if}
      <div class="min-w-4 flex-auto"></div>
      <!-- One ghost per real control, at its real width and radius: the
           Markdown verb, Copy, the ⋯ menu, and the Ask Solus button (the row's
           one filled surface, carrying the same margins that set it apart). -->
      <div
        class="flex shrink-0 items-center gap-1.5 pr-[max(0.875rem,var(--solus-pane-chrome-inset,3.25rem))]"
        aria-hidden="true"
      >
        <Skeleton class="h-6 w-[4.625rem] rounded-[0.375rem]" />
        <Skeleton class="h-6 w-[2.75rem] rounded-[0.375rem]" />
        <Skeleton class="size-6 rounded-[0.375rem]" />
        <Skeleton class="mr-0.5 ml-1 h-6 w-[6.75rem] rounded-[0.4375rem]" />
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

      <div class="doc-skeleton-column flex min-w-0 flex-1 flex-col" style:--solus-doc-rail-w={railWidth}>
        <!-- Nothing scrolls yet: a placeholder that can be scrolled away from
             would leave the real document scrolled somewhere arbitrary. The
             gutter is still reserved, like the real scroll region's. -->
        <div class="min-h-0 flex-1 overflow-hidden [scrollbar-gutter:stable]">
          <div class="doc-skeleton-page">
            <div class="doc-skeleton-prose min-w-0 flex-1" aria-hidden="true">
              <Skeleton class="rounded-lg" style="height:2.53em;width:58%" />
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
            <!-- The comment margin, held open but left empty: the threads are
                 the reader's, not ours to invent while the chunk loads. -->
            <div class="doc-skeleton-rail" aria-hidden="true"></div>
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
    class="doc-skeleton-backdrop fixed inset-0 z-[10000] flex items-center justify-center"
    role="presentation"
  >
    {@render shellInner()}
  </div>
{/if}

<style>
  .doc-skeleton-breadcrumb {
    flex-shrink: 0;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: 'Geist Mono', var(--solus-code-font-family);
    font-size: var(--text-xs);

    color: var(--solus-text-tertiary);
  }

  /* The measure ladder and the comment margin, copied off the real doc column
     (index.css) rather than approximated — both are `cqi` on the shell
     container, which is what makes a split pane narrow the column instead of
     the window doing it. */
  .doc-skeleton-column {
    --solus-doc-size: var(--text-body);
    --solus-doc-measure: clamp(66ch, 68cqi, 112ch);
  }
  .doc-skeleton-page {
    display: flex;
    align-items: flex-start;
    width: min(100%, calc(var(--solus-doc-measure) + 7rem + var(--solus-doc-rail-w, 0px)));
    margin-inline: auto;
  }
  .doc-skeleton-rail {
    flex: 0 0 var(--solus-doc-rail-w, 0px);
  }
  /* Type-relative, like the document it stands in for: every bar in the markup
     is sized in `em` off the body size, so the placeholder rescales with the
     column instead of drifting out of step with it. */
  .doc-skeleton-prose {
    --doc-pad-x: 3.5rem;
    max-width: calc(var(--solus-doc-measure) + 2 * var(--doc-pad-x));
    padding: 2.75rem var(--doc-pad-x) 4rem;
    font-size: var(--solus-doc-size);
  }
  .doc-skeleton-backdrop {
    background: radial-gradient(
      circle at 50% 38%,
      color-mix(in srgb, var(--solus-modal-scrim) 82%, transparent) 0%,
      var(--solus-modal-scrim) 72%
    );
  }

  /* The same pane-width ladder the real column steps down, so the swap is a
     fade rather than a reflow at every width. */
  @container (max-width: 73.75rem) {
    .doc-skeleton-prose {
      --doc-pad-x: 2.5rem;
    }
  }
  @container (max-width: 56.25rem) {
    .doc-skeleton-prose {
      --doc-pad-x: 1.75rem;
    }
  }
  @container (max-width: 45rem) {
    .doc-skeleton-column {
      --solus-doc-size: var(--text-body);
    }
    .doc-skeleton-prose {
      --doc-pad-x: 1.375rem;
    }
  }
  @media (max-width: 767px) {
    .doc-skeleton-column {
      --solus-doc-size: var(--text-body);
    }
    .doc-skeleton-prose {
      padding-top: 1.25rem;
    }
  }
</style>
