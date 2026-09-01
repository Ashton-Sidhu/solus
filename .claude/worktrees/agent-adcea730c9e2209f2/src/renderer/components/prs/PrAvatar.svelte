<script lang="ts">
  import { initials } from "../pr-review/lib/activity-data";

  // PR-surface avatar: the author's image when GitHub gave us one, otherwise
  // an initials disc. `size` carries both the box and text size classes
  // (e.g. "size-5 text-[0.5625rem]").
  let { name, url = "", size }: { name: string; url?: string; size: string } = $props();
</script>

{#if url}
  <img
    src={url}
    alt={name}
    class="shrink-0 rounded-full object-cover outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10 {size}"
  />
{:else}
  <span
    class="grid shrink-0 place-items-center rounded-full bg-(--solus-accent) font-semibold text-(--solus-on-accent,#fff) {size}"
  >
    {initials(name)}
  </span>
{/if}
