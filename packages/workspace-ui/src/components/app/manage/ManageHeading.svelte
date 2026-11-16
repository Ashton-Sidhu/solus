<script lang="ts">
  import type { Snippet } from "svelte";

  /** The head of one section of the Manage page: its name, one line on what it holds, and its own controls. */
  interface Props {
    title: string;
    description?: string;
    actions?: Snippet;
  }
  let { title, description, actions }: Props = $props();
</script>

<!-- The Settings page's own head: the same size, weight, and gap, so a Manage
     section reads as a Settings page. -->
<header class="flex flex-wrap items-start gap-x-3 gap-y-2 pb-8">
  <div class="flex min-w-40 flex-1 flex-col gap-1.5">
    <h2 class="m-0 text-[1.75rem] leading-tight font-medium tracking-[-0.015em] text-foreground">{title}</h2>
    {#if description}
      <p class="m-0 text-sm text-(--solus-text-secondary) text-pretty">{description}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
  {/if}
</header>
