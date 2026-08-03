<script lang="ts">
  import type { Snippet } from "svelte";
  import { XIcon } from "phosphor-svelte";

  /** Page identity block for library surfaces, matching the pull request
   *  masthead: quiet eyebrow, large title, supporting facts, and actions
   *  bottom-aligned on the right. */
  interface Props {
    title: string;
    eyebrow?: string;
    subtitle?: string | Snippet;
    /** Small accent glyph rendered beside the eyebrow (size 11 reads best). */
    icon: Snippet;
    /** `large` gives the title the display setting the Automations landing page
     *  uses, where the masthead carries the page rather than sharing it with a
     *  dense table. */
    size?: "default" | "large";
    actions?: Snippet;
    onClose?: () => void;
  }
  let {
    title,
    eyebrow = "Workspace",
    subtitle,
    icon,
    size = "default",
    actions,
    onClose,
  }: Props = $props();
</script>

<header class="flex items-end justify-between gap-4 pb-[clamp(16px,2vw,28px)]">
  <div class="flex min-w-0 flex-col gap-2">
    <div
      class="flex min-w-0 items-center gap-2 font-mono text-[9.5px] tracking-widest text-muted-foreground uppercase"
    >
      <span class="shrink-0 text-primary" aria-hidden="true">{@render icon()}</span>
      <span class="min-w-0 truncate">{eyebrow}</span>
    </div>

    <h1
      class="text-foreground {size === 'large'
        ? 'text-[2.375rem] leading-none font-medium tracking-[-0.035em]'
        : 'text-[26px] font-semibold tracking-[-0.02em]'}"
    >
      {title}
    </h1>

    {#if typeof subtitle === "string"}
      <p class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted-foreground">
        {subtitle}
      </p>
    {:else if subtitle}
      <p class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-muted-foreground">
        {@render subtitle()}
      </p>
    {/if}
  </div>

  <div class="mb-0.5 flex shrink-0 items-center gap-1.5">
    {#if actions}
      {@render actions()}
    {/if}
    {#if onClose}
      <button
        type="button"
        class="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent bg-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onclick={onClose}
        aria-label="Close"
      >
        <XIcon size={14} />
      </button>
    {/if}
  </div>
</header>
