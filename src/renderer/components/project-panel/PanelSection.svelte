<script lang="ts">
  import type { Snippet } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { CaretDownIcon } from "phosphor-svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Sidebar from "../ui/sidebar";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  interface Props {
    title: string;
    collapsed: boolean;
    onToggle: () => void;
    headerDetail?: string;
    headerExtra?: Snippet;
    children: Snippet;
  }

  let { title, collapsed, onToggle, headerDetail, headerExtra, children }: Props =
    $props();

  function toggle() {
    onToggle();
    requestInputFocus();
  }
</script>

<!-- Card fill matches the conversation surface it floats on, per the design
     pack — the 1px border and lift do the separating, not a tint. A
     collapsed section leaves a visible gap rather than silently shortening. -->
<Sidebar.Group
  role="group"
  class="group/section min-h-0 shrink-0 gap-0 rounded-2xl border border-[color-mix(in_srgb,var(--solus-text-primary)_8%,transparent)] bg-(--solus-container-bg) p-1.5 shadow-[0_1px_2px_-1px_rgba(0,0,0,0.05)] dark:border-[color-mix(in_srgb,var(--solus-text-primary)_11%,transparent)] dark:shadow-none"
>
  <Sidebar.GroupLabel
    class="group/header h-auto min-h-6 justify-between gap-1 px-1.5 py-0"
  >
    <button
      class="flex min-h-6 min-w-0 flex-1 cursor-pointer items-center border-none bg-transparent text-[0.625rem] font-medium tracking-[0.09em] text-(--solus-text-tertiary) uppercase transition-[color,transform] duration-150 hover:text-(--solus-text-primary) active:scale-[0.996] focus-visible:rounded-md focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
      type="button"
      aria-expanded={!collapsed}
      onclick={toggle}
    >
      <span class="inline-flex min-w-0 items-baseline gap-1.5 truncate">
        <span class="shrink-0">{title}</span>
        {#if headerDetail}
          <span
            class="min-w-0 truncate text-[0.6875rem] font-normal tracking-normal text-(--solus-text-tertiary) normal-case"
            aria-live="polite"
          >
            {headerDetail}
          </span>
        {/if}
      </span>
    </button>
    {#if headerExtra}
      <!-- The header's trailing value is a reading, not a label: regular weight,
           so only the heading itself carries the 500. -->
      <span class="min-w-0 shrink-0 font-normal text-(--solus-text-tertiary)">
        {@render headerExtra()}
      </span>
    {/if}
    <!-- Disclosure caret closes the header row, so the section's own control
         (+ / refresh) sits beside it rather than across the card. Redundant
         with the title button, so it stays out of the tab order. -->
    <button
      class="flex size-4 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-(--solus-text-tertiary) transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] {collapsed
        ? '-rotate-90 opacity-70'
        : 'opacity-60'}"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      onclick={toggle}
    >
      <CaretDownIcon size={9} weight="bold" />
    </button>
  </Sidebar.GroupLabel>
  {#if !collapsed}
    <div
      class="min-h-0 pt-1.5"
      transition:slide={{ duration: reduceMotion ? 0 : 180, easing: cubicOut }}
    >
      {@render children()}
    </div>
  {/if}
</Sidebar.Group>
