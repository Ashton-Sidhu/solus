<script lang="ts">
  import type { Snippet } from "svelte";

  type CalloutKind = "info" | "note" | "warning" | "caution";

  interface Props {
    kind: CalloutKind;
    label?: string;
    role?: "note" | "alert" | "status";
    class?: string;
    children: Snippet;
    action?: Snippet;
  }

  let { kind, label, role = kind === "warning" || kind === "caution" ? "alert" : "note", class: className = "", children, action }: Props = $props();

  const DEFAULT_LABELS = {
    info: "INFO",
    note: "NOTE",
    warning: "WARNING",
    caution: "CAUTION",
  } as const satisfies Record<CalloutKind, string>;

  const KIND_COLOR = {
    info: "var(--solus-art-5)",
    note: "var(--solus-art-5)",
    warning: "var(--solus-art-2)",
    caution: "var(--solus-art-negative)",
  } as const satisfies Record<CalloutKind, string>;

  const accent = $derived(KIND_COLOR[kind]);
  const heading = $derived(label ?? DEFAULT_LABELS[kind]);
</script>

<!-- Unboxed editorial callout band matching Solus prose-callout: top semantic hairline,
     mono uppercase kind label, and body content directly on the page surface. -->
<div
  {role}
  aria-live={role === "alert" ? "polite" : undefined}
  class="flex flex-col gap-1.5 border-b border-border/60 py-3 @min-[36rem]/pane:flex-row @min-[36rem]/pane:items-start @min-[36rem]/pane:gap-5 {className}"
  style="border-top: 1px solid color-mix(in oklch, {accent} 42%, transparent);"
>
  <span
    class="shrink-0 pt-0.5 font-mono text-[10px] font-medium tracking-[0.1em] uppercase select-none @min-[36rem]/pane:w-19"
    style="color: color-mix(in oklch, {accent} 78%, var(--foreground));"
  >
    {heading}
  </span>
  <div class="min-w-0 flex-1 text-[13px] leading-[1.45] text-foreground/90">
    {@render children()}
  </div>
  {#if action}
    <div class="flex shrink-0 items-center">
      {@render action()}
    </div>
  {/if}
</div>
