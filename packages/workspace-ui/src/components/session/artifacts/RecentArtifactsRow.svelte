<script lang="ts" generics="Item extends RecentItem">
  import { ChevronDown as CaretIcon, History as RecentIcon } from "@lucide/svelte";
  import type { RecentItem } from "@solus/client-core/recent-artifacts";
  import { recentArtifactKey } from "@solus/client-core/recent-artifacts";
  import { messageTimestampClock } from "../../../lib/shared-clock";
  import * as Carousel from "../../ui/carousel";
  import RecentArtifactCard from "./RecentArtifactCard.svelte";

  /**
   * A "Recently viewed" row, as a section of its own with no card around it:
   * at the top of the Threads surface (docs/plans/session-artifacts.md
   * decision 17) and of the Workspace page (docs/workspace-page.md). Its
   * label folds it; it scrolls sideways, and the arrows page through it.
   */
  let {
    items,
    serverIdOf,
    isDark,
    onOpen,
  }: {
    items: readonly Item[];
    /** The host that holds an item's files and pictures. */
    serverIdOf: (item: Item) => string;
    /** Which still of an artifact the cards show. */
    isDark: boolean;
    onOpen: (item: Item) => void;
  } = $props();

  let open = $state(true);

  // The ages read in minutes, so the row moves once a minute and never faster.
  let now = $state(Date.now());
  $effect(() =>
    messageTimestampClock.subscribe((value) => {
      now = value;
    }),
  );

  const options = { align: "start" as const, slidesToScroll: "auto" as const, containScroll: "trimSnaps" as const };
</script>

<Carousel.Root opts={options} class="min-w-0" data-testid="recent-artifacts">
  <!-- A section with no card around it: its label, as the cards below draw theirs, heads it. -->
  <section aria-label="Recently viewed">
    <!-- The arrows sit beside the label, not inside its button. -->
    <div class="flex h-8 min-w-0 items-center gap-1 pointer-coarse:h-11">
      <h3 class="m-0 min-w-0 flex-1 font-normal">
        <button
          type="button"
          aria-expanded={open}
          class="group/head flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 bg-transparent px-2 text-left text-muted-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-11"
          onclick={() => (open = !open)}
        >
          <RecentIcon size={14} strokeWidth={1.75} class="shrink-0" />
          <span class="min-w-0 truncate text-xs font-medium tracking-[0.04em] uppercase">Recently viewed</span>
          <span class="shrink-0 text-xs tabular-nums opacity-60">{items.length}</span>
          <CaretIcon
            size={14}
            class="shrink-0 transition-[transform,opacity] duration-300 ease-(--ease-premium) group-hover/head:opacity-100 group-focus-visible/head:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100 {open
              ? 'opacity-0'
              : '-rotate-90 opacity-100'}"
          />
        </button>
      </h3>
      <div class="flex shrink-0 gap-0.5 pr-0.5 {open ? '' : 'invisible'}">
        <Carousel.Previous class="static size-6 border-0 bg-transparent shadow-none pointer-coarse:tap-area" />
        <Carousel.Next class="static size-6 border-0 bg-transparent shadow-none pointer-coarse:tap-area" />
      </div>
    </div>
    <!-- Closed, the row stays mounted and leaves the tab order when the body has shut. -->
    <div
      class="grid transition-[grid-template-rows] duration-[380ms] ease-(--ease-premium) motion-reduce:transition-none {open
        ? 'grid-rows-[1fr]'
        : 'grid-rows-[0fr]'}"
    >
      <div class="min-h-0 overflow-hidden px-1 {open ? '' : 'invisible [transition:visibility_0s_380ms]'}">
        <!-- Room on every side of each card for its hairline, hover ring, and focus outline (2px, offset 2px),
             which the scroller would otherwise clip: the content starts 4px in, and the last card keeps 4px after it. -->
        <Carousel.Content class="-ms-1.5 py-1.5">
          {#each items as item (recentArtifactKey(item.artifact))}
            <Carousel.Item class="basis-auto ps-2.5 last:pe-1">
              <RecentArtifactCard {item} serverId={serverIdOf(item)} {isDark} {now} onOpen={() => onOpen(item)} />
            </Carousel.Item>
          {/each}
        </Carousel.Content>
      </div>
    </div>
  </section>
</Carousel.Root>
