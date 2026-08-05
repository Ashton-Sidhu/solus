<script lang="ts">
  import { Skeleton } from "../skeleton";

  /** Loading silhouette for the grouped list. Mirrors ListGroup's 30px header
   *  line and ListRow's slot geometry (avatar · ident · title … time) so the
   *  real rows land on the same x when the data arrives — no reflow at the
   *  swap. Title widths come from a fixed plan rather than randomness, so the
   *  shape is stable across renders. */
  interface Props {
    /** Same value the page passes to ListRow: 62 for tasks, 44 for PRs. */
    identWidth?: number;
    /** Title width (% of the elastic slot) per row, grouped as they render. */
    plan?: number[][];
  }
  let {
    identWidth = 62,
    plan = [
      [58, 40, 49, 34],
      [45, 30, 38],
    ],
  }: Props = $props();
</script>

<div aria-busy="true" aria-label="Loading">
  {#each plan as rows, groupIndex (groupIndex)}
    <div class="pt-1.5 opacity-(--group-fade)" style="--group-fade: {100 - groupIndex * 35}%">
      <!-- Group header — the hairline is real, only the label is a placeholder -->
      <div class="flex h-[30px] w-full items-center gap-2.5 px-1.5">
        <span class="size-[11px] shrink-0"></span>
        <Skeleton class="h-2 w-14 rounded-[3px]" />
        <span class="h-px flex-1 bg-[var(--hairline)]"></span>
      </div>

      {#each rows as width, rowIndex (rowIndex)}
        <div
          class="flex h-11 w-full items-center gap-[11px] pr-3 pl-2.5 [animation-delay:var(--stagger)]"
          style="--stagger: {(groupIndex * 4 + rowIndex) * 90}ms"
        >
          <Skeleton class="size-5 shrink-0 rounded-full" />
          <Skeleton class="h-2.5 shrink-0 rounded-[3px] w-(--ident-w)" style="--ident-w: {identWidth}px" />
          <Skeleton class="h-2.5 max-w-[520px] shrink-0 rounded-[3px] w-(--title-w)" style="--title-w: {width}%" />
          <span class="flex-1"></span>
          <Skeleton class="h-2.5 w-8 shrink-0 rounded-[3px]" />
        </div>
      {/each}
    </div>
  {/each}
</div>
