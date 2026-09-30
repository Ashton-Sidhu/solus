<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";

  /**
   * One line of a reading: an icon in a tinted badge, a title, and a detail.
   * With `onOpen` it is a way into the trace; without, a statement that stays
   * text. The findings and the result draw every line with it.
   */
  interface Props {
    icon: typeof ChevronRight;
    /** The tint. Null is grey: the line is information, not a verdict. */
    color: string | null;
    title: string;
    detail: string;
    openTitle?: string;
    onOpen?: () => void;
  }

  let { icon: Icon, color, title, detail, openTitle = "Open in the trace", onOpen }: Props = $props();
</script>

{#snippet body()}
  <span
    class="flex size-7 shrink-0 items-center justify-center rounded-md"
    style:color={color ?? "var(--muted-foreground)"}
    style:background-color={color ? `color-mix(in srgb, ${color} 12%, transparent)` : "var(--wash-2)"}
    aria-hidden="true"
  >
    <Icon size={14} strokeWidth={2} />
  </span>
  <span class="flex min-w-0 flex-1 flex-col">
    <span class="truncate text-insights-summary select-text" {title}>{title}</span>
    <span class="truncate text-insights-chrome text-muted-foreground select-text" title={detail}>{detail}</span>
  </span>
{/snippet}

{#if onOpen}
  <button
    type="button"
    class="group flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg px-2 py-1.5 text-left transition-colors select-none hover:bg-[var(--wash-1)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary)"
    title={openTitle}
    onclick={onOpen}
  >
    {@render body()}
    <ChevronRight
      class="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      aria-hidden="true"
    />
  </button>
{:else}
  <div class="flex items-center gap-3 px-2 py-1.5">
    {@render body()}
  </div>
{/if}
