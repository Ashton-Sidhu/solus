<script lang="ts">
  import { PanelLeft as SidebarSimpleIcon } from "@lucide/svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { frameChrome } from "./frame-chrome.store.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";

  // `sidebar` expands the collapsed session sidebar; `projectPanel` expands the
  // dev-only project panel. Each renders only when its panel is collapsed and a
  // toggle has been registered by the workspace layout, so it stays hidden on
  // views that do not host the frame chrome.
  //
  // The button renders inline so page headers can align it with their content
  // gutters and keep the adjacent title/actions in the same visual column.
  //
  // `size` is the box it has to sit in, not a style preference: dense chrome
  // strips run 20px boxes, a header action row runs the soft raised pill its
  // neighbours use. A 20px button in a header row reads as misaligned even
  // though both are centred, so the host states which row this instance
  // belongs to.
  let {
    variant,
    size = "strip",
  }: {
    variant: "sidebar" | "projectPanel";
    size?: "strip" | "header";
  } = $props();

  const visible = $derived(
    variant === "sidebar"
      ? !frameChrome.sidebarOpen && !!frameChrome.expandSidebar
      : import.meta.env.DEV &&
          !frameChrome.projectPanelOpen &&
          !!frameChrome.toggleProjectPanelFromFrame,
  );

  function expand() {
    if (variant === "sidebar") frameChrome.expandSidebar?.();
    else frameChrome.toggleProjectPanelFromFrame?.();
  }
</script>

{#if visible}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    class={size === "header"
      ? PAGE_SOFT_ICON_BTN
      : "no-drag flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent p-0 text-(--solus-text-tertiary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-input-focus-border)"}
    onmousedown={(e) => e.stopPropagation()}
    onclick={expand}
    aria-label={variant === "sidebar"
      ? "Expand sidebar"
      : "Expand project panel"}
  >
    <SidebarSimpleIcon
      size={size === "header" ? 15 : 13}
      strokeWidth={size === "header" ? 1.5 : 2}
      mirrored={variant === "projectPanel"}
    />
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={variant === "sidebar"
      ? `Expand sidebar (${comboHint("global.toggle-sidebar")})`
      : `Expand project panel (${comboHint("global.toggle-project-panel")})`} />
  </TooltipUI.Root>
{/if}
