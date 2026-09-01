<script lang="ts">
  import { Skeleton } from "../ui/skeleton";

  let {
    label,
    skipMotion = false,
  }: {
    label: string;
    skipMotion?: boolean;
  } = $props();
</script>

<!-- A compact preview of the guide that is being authored. The geometry uses
     the real guide's title, overview, and two-column concern layout instead of
     a generic card spinner, so the background work has an honest destination. -->
<div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <div
    class="mx-auto w-[88%] overflow-hidden rounded-2xl bg-(--solus-tx-card-bg) shadow-(--solus-tx-card-shadow)"
    role="status"
    aria-label={`Generating ${label.toLowerCase()} review guide`}
    data-testid="review-guide-skeleton"
  >
    <div class="border-b border-(--solus-art-border) px-4 pt-4 pb-3.5" aria-hidden="true">
      <Skeleton class="h-2 w-16 rounded-[0.1875rem]" />
      <Skeleton class="mt-2.5 h-4 w-[min(18rem,72%)] rounded" />
      <div class="mt-3 flex flex-col gap-1.5">
        <Skeleton class="h-2.5 w-[92%] rounded-[0.1875rem]" />
        <Skeleton class="h-2.5 w-[68%] rounded-[0.1875rem]" />
      </div>
    </div>

    <div class="grid grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)]" aria-hidden="true">
      <div class="border-r border-(--solus-art-border) px-4 py-3.5">
        <Skeleton class="h-2.5 w-12 rounded-[0.1875rem]" />
        <Skeleton class="mt-2 h-3 w-[82%] rounded-[0.1875rem]" />
        <Skeleton class="mt-1.5 h-2.5 w-full rounded-[0.1875rem]" />
        <Skeleton class="mt-1.5 h-2.5 w-[72%] rounded-[0.1875rem]" />
      </div>
      <div class="px-4 py-3.5">
        <div class="flex gap-1.5">
          <Skeleton class="h-4 w-20 rounded-md" />
          <Skeleton class="h-4 w-14 rounded-md" />
        </div>
        <Skeleton class="mt-2.5 h-2.5 w-[90%] rounded-[0.1875rem]" />
        <Skeleton class="mt-1.5 h-2.5 w-[76%] rounded-[0.1875rem]" />
        <Skeleton class="mt-1.5 h-2.5 w-[84%] rounded-[0.1875rem]" />
      </div>
    </div>
  </div>
</div>
