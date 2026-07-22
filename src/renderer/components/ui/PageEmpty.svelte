<script lang="ts">
  /**
   * The one empty-state layout for the library pages (Tasks, PRs, Folio,
   * Plans, Automations): medallion motif icon + title + description +
   * action row, built on the shadcn Empty parts.
   *
   * Contract: blank slates pass `icon` (accent tone) and a primary action;
   * error/unavailable states use tone="muted"; filter-miss states omit the
   * icon and offer a clear-filters secondary action; loading states pass
   * only children.
   */
  import type { Component, Snippet } from "svelte";
  import {
    Empty,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
    EmptyDescription,
    EmptyContent,
  } from "./empty";

  let {
    icon,
    tone = "accent",
    title,
    compact = false,
    children,
    actions,
  }: {
    /** Motif icon for the medallion; omit on filter-miss/loading states. */
    icon?: Component<{ size?: number; weight?: string }>;
    /** accent = invitation (blank slate); muted = error/unavailable. */
    tone?: "accent" | "muted";
    title?: string;
    /** Tighter vertical padding for pill-mode surfaces. */
    compact?: boolean;
    /** Description content. */
    children?: Snippet;
    /** Action buttons (PAGE_PRIMARY_BTN / PAGE_SECONDARY_BTN). */
    actions?: Snippet;
  } = $props();
</script>

<Empty class={compact ? "px-4 py-10" : "px-4 py-16"}>
  <EmptyHeader>
    {#if icon}
      {@const Icon = icon}
      <EmptyMedia
        variant="icon"
        class="mb-1 size-12 rounded-full [&_svg:not([class*='size-'])]:size-[1.375rem] {tone ===
        'accent'
          ? 'bg-(--solus-accent-light) text-(--solus-accent) shadow-[0_0_0_0.4375rem_color-mix(in_srgb,var(--solus-accent-light)_45%,transparent)]'
          : 'bg-(--solus-surface-hover) text-(--solus-text-secondary) shadow-[0_0_0_0.4375rem_color-mix(in_srgb,var(--solus-surface-hover)_45%,transparent)]'}"
      >
        <Icon weight="fill" />
      </EmptyMedia>
    {/if}
    {#if title}
      <EmptyTitle
        class="text-[0.9375rem] font-semibold tracking-[-0.01em] text-(--solus-text-primary)"
      >
        {title}
      </EmptyTitle>
    {/if}
    {#if children}
      <EmptyDescription
        class="max-w-[25rem] text-[0.8125rem] leading-[1.55] text-(--solus-text-tertiary)"
      >
        {@render children()}
      </EmptyDescription>
    {/if}
  </EmptyHeader>
  {#if actions}
    <EmptyContent class="w-auto max-w-none flex-row flex-wrap justify-center">
      {@render actions()}
    </EmptyContent>
  {/if}
</Empty>
