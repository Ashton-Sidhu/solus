<script lang="ts">
  /** The Solus mark and wordmark in the sidebar's title bar. The wordmark's
   *  ink is the theme's text colour warmed with the mark's own colour: plain
   *  text colour reads as a black slab beside the mark. With `onclick`
   *  the lockup is a button that opens a new draft; a reader who may not
   *  start a session gets the same lockup as plain decoration. The wordmark
   *  drops in a narrow sidebar so the title bar's controls keep their room. */
  import { Button } from "../ui/button";
  import * as TooltipUI from "../ui/tooltip";

  let {
    onDarkSky = false,
    onclick,
  }: {
    /** The lockup sits on a sky that is dark in both themes. */
    onDarkSky?: boolean;
    onclick?: () => void;
  } = $props();
</script>

{#snippet lockup()}
  <svg viewBox="0 0 18 18" class="size-5 shrink-0" aria-hidden="true">
    <circle cx="9" cy="9" r="4.8" class={onDarkSky ? "fill-[#f6c48e]" : "fill-[#b45a3c]"} />
    <g
      fill="none"
      stroke-width="1.7"
      stroke-linecap="round"
      class={onDarkSky ? "stroke-[#f09a76]" : "stroke-[#d97757]"}
    >
      <path d="M9,1 A8,8 0 0 1 17,9" />
      <path d="M15.72,14.44 A8,8 0 0 1 6.44,16.68" />
      <path d="M2.28,14.44 A8,8 0 0 1 1,6.44" />
    </g>
  </svg>
  <span
    class="font-[family-name:Geist,var(--solus-font-family)] text-[1.125rem] leading-none font-medium tracking-[-0.035em] @max-[17rem]/rail:hidden {onDarkSky
      ? 'text-white'
      : 'text-[color-mix(in_oklch,var(--foreground)_62%,#b45a3c)]'}">solus</span
  >
{/snippet}

{#if onclick}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          variant="ghost"
          size="sm"
          aria-label="Solus: new draft"
          class="-ml-1.5 h-6 gap-2 rounded-md px-1.5"
          {onclick}
        >
          {@render lockup()}
        </Button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content side="bottom" value="New draft" />
  </TooltipUI.Root>
{:else}
  <span class="flex h-6 items-center gap-2">
    {@render lockup()}
    <span class="sr-only">Solus</span>
  </span>
{/if}
