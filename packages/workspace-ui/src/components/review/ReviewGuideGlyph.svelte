<script lang="ts">
  import { BookOpen, BookOpenCheck } from "@lucide/svelte";
  let { size = 16, weight = "regular", class: className = "" }: {
    size?: number;
    weight?: "regular" | "fill";
    class?: string;
  } = $props();
</script>

{#if weight === "fill"}
  <BookOpenCheck {size} class={className} aria-hidden="true" />
{:else}
  <BookOpen {size} class={className} aria-hidden="true" />
{/if}
