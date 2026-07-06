<script lang="ts">
  import type { Snippet } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { CaretDownIcon } from "phosphor-svelte";
  import { requestInputFocus } from "../../lib/inputFocus";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  interface Props {
    title: string;
    collapsed: boolean;
    onToggle: () => void;
    grow?: boolean;
    headerExtra?: Snippet;
    children: Snippet;
  }

  let { title, collapsed, onToggle, grow = false, headerExtra, children }: Props = $props();

  function toggle() {
    onToggle();
    requestInputFocus();
  }
</script>

<section
  class="group/section relative min-h-0 shrink-0 not-first:before:content-[''] not-first:before:absolute not-first:before:top-0 not-first:before:inset-x-3.5 not-first:before:h-px not-first:before:bg-[color-mix(in_srgb,var(--solus-container-border)_60%,transparent)] {grow &&
  !collapsed
    ? 'flex flex-1 flex-col'
    : ''}"
>
  <div
    class="group/header flex min-h-8 items-center justify-between gap-2 px-3.5 pt-2 pb-1 group-first/section:min-h-6 group-first/section:pt-0"
  >
    <button
      class="flex min-h-6 min-w-0 flex-1 cursor-pointer items-center gap-1 border-none bg-transparent text-[0.625rem] font-semibold tracking-[0.09em] text-(--solus-text-tertiary) uppercase transition-[color,transform] duration-150 hover:text-(--solus-text-primary) active:scale-[0.996] focus-visible:rounded-md focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
      type="button"
      aria-expanded={!collapsed}
      onclick={toggle}
    >
      <span class="inline-flex min-w-0 items-center truncate">{title}</span>
      <!-- Disclosure caret: always visible while collapsed (so the closed state
           stays discoverable), revealed on hover while open. -->
      <span
        class="inline-flex shrink-0 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] {collapsed
          ? '-rotate-90 opacity-70'
          : 'opacity-0 group-hover/header:opacity-60'}"
        aria-hidden="true"
      >
        <CaretDownIcon size={9} weight="bold" />
      </span>
    </button>
    {#if headerExtra}
      <span class="min-w-0 font-medium text-(--solus-text-tertiary)">
        {@render headerExtra()}
      </span>
    {/if}
  </div>
  {#if !collapsed}
    <div
      class="min-h-0 px-3.5 pb-3.5 {grow ? 'flex flex-1 overflow-hidden' : 'overflow-y-auto'}"
      transition:slide={{ duration: reduceMotion ? 0 : 180, easing: cubicOut }}
    >
      {@render children()}
    </div>
  {/if}
</section>
