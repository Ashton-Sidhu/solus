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

<header class="flex flex-wrap items-start gap-x-3 gap-y-2 pb-4">
  <div class="min-w-40 flex-1">
    <h2 class="m-0 text-base font-medium tracking-[-0.006em] text-foreground">{title}</h2>
    {#if description}
      <p class="m-0 pt-0.5 text-sm text-muted-foreground text-pretty">{description}</p>
    {/if}
  </div>
  {#if actions}
    <div class="flex shrink-0 flex-wrap items-center gap-2">{@render actions()}</div>
  {/if}
</header>
