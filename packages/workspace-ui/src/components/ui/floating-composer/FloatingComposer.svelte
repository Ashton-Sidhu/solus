<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "svelte/motion";
  import { scale } from "svelte/transition";
  import { MessageCircle as ChatCircleIcon } from "@lucide/svelte";
  import { cn } from "../../../lib/utils";
  import { Button } from "../button";

  let {
    expanded = $bindable(false),
    label,
    hasUnsent = false,
    badgeCount = 0,
    onExpand,
    onFold,
    onOpened,
    icon,
    testId = "page-composer",
    panelClass,
    children,
    class: glyphClass,
  }: {
    expanded?: boolean;
    label: string;
    hasUnsent?: boolean;
    badgeCount?: number;
    onExpand?: () => void;
    onFold?: () => void;
    onOpened?: () => void;
    /** The glyph's icon; the chat bubble when absent. */
    icon?: Snippet;
    /** Two orbs on one page need their own ids: `<testId>` for the open
     *  composer, `open-<testId>` for the glyph. */
    testId?: string;
    /** Placement of the open panel, when it is not the corner's: a second
     *  orb's panel stops short of the first orb. */
    panelClass?: string;
    children: Snippet;
    class?: string;
  } = $props();

  let composerEl = $state<HTMLDivElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);

  async function expand() {
    onExpand?.();
    expanded = true;
    if (!prefersReducedMotion.current) return;
    await tick();
    onOpened?.();
  }

  export async function fold(restoreFocus = true) {
    expanded = false;
    onFold?.();
    await tick();
    if (restoreFocus) trigger?.focus();
  }

  // Menus can open outside the page. Only a click within the page folds an
  // empty composer; a written draft stays open.
  $effect(() => {
    const host = expanded ? composerEl?.parentElement : null;
    if (!host) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || !host.contains(target) || composerEl?.contains(target)) return;
      if (!hasUnsent) void fold(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  });
</script>

{#if expanded}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={composerEl}
    class={cn(
      "absolute right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] z-30 w-[min(44rem,calc(100%-1.5rem))] origin-bottom-right",
      panelClass,
    )}
    data-testid={testId}
    in:scale={{ start: 0.08, opacity: 0, duration: prefersReducedMotion.current ? 0 : 200, easing: cubicOut }}
    out:scale={{ start: 0.08, opacity: 0, duration: prefersReducedMotion.current ? 0 : 140, easing: cubicOut }}
    onintroend={() => onOpened?.()}
    onkeydown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.stopPropagation();
        void fold();
      }
    }}
  >
    {@render children()}
  </div>
{:else}
  <div
    class={cn("absolute right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] z-30", glyphClass)}
    in:scale={{ start: 0.6, opacity: 0, duration: prefersReducedMotion.current ? 0 : 140, delay: prefersReducedMotion.current ? 0 : 100, easing: cubicOut }}
  >
    <Button
      variant="outline"
      size="icon-lg"
      class={cn(
        "relative size-10 rounded-full shadow-[shadow:0_4px_16px_color-mix(in_oklch,var(--foreground)_10%,transparent)] pointer-coarse:size-12",
        hasUnsent && "after:absolute after:top-1.5 after:right-1.5 after:size-2 after:rounded-full after:bg-(--solus-accent)",
      )}
      data-testid="open-{testId}"
      title={hasUnsent ? `${label} — unsent message` : label}
      aria-label={label}
      bind:ref={trigger}
      aria-expanded={expanded}
      onclick={expand}
    >
      {#if icon}{@render icon()}{:else}<ChatCircleIcon size={18} strokeWidth={1.5} />{/if}
      {#if badgeCount > 0}
        <span class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--solus-accent) px-1 text-[0.625rem] font-medium text-primary-foreground tabular-nums">
          {badgeCount}
        </span>
      {/if}
    </Button>
  </div>
{/if}
