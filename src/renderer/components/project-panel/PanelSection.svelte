<script lang="ts">
  import type { Snippet } from "svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
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

<section class="panel-section" class:panel-section-grow={grow && !collapsed}>
  <div class="section-header">
    <button class="section-toggle" type="button" aria-expanded={!collapsed} onclick={toggle}>
      <span class="section-title">{title}</span>
    </button>
    {#if headerExtra}
      <span class="section-extra">
        {@render headerExtra()}
      </span>
    {/if}
  </div>
  {#if !collapsed}
    <div
      class="section-body"
      class:section-body-grow={grow}
      transition:slide={{ duration: reduceMotion ? 0 : 180, easing: cubicOut }}
    >
      {@render children()}
    </div>
  {/if}
</section>

<style>
  .panel-section {
    position: relative;
    flex-shrink: 0;
    min-height: 0;
  }
  .panel-section:not(:first-child)::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0.875rem;
    right: 0.875rem;
    height: 1px;
    background: color-mix(in srgb, var(--solus-container-border) 60%, transparent);
  }
  .panel-section-grow {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .section-header {
    min-height: 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.875rem 0.25rem;
  }
  .panel-section:first-child .section-header {
    min-height: 1.5rem;
    padding-top: 0;
  }
  .section-toggle {
    min-width: 0;
    min-height: 1.5rem;
    flex: 1;
    display: flex;
    align-items: center;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    transition: color 0.15s ease, transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .section-toggle:hover {
    color: var(--solus-text-primary);
  }
  .section-toggle:active {
    transform: scale(0.996);
  }
  .section-toggle:focus-visible {
    outline: none;
    border-radius: 0.375rem;
    box-shadow: 0 0 0 0.125rem color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .section-title {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .section-extra {
    min-width: 0;
    color: var(--solus-text-tertiary);
    font-weight: 500;
  }
  .section-body {
    min-height: 0;
    overflow-y: auto;
    padding: 0 0.875rem 0.875rem;
  }
  .section-body-grow {
    flex: 1;
    display: flex;
    overflow: hidden;
  }
</style>
