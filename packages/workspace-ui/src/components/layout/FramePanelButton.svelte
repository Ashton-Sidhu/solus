<script lang="ts">
  import { PanelLeft as SidebarSimpleIcon } from "@lucide/svelte";
  import * as TooltipUI from "@solus/workspace-ui/components/ui/tooltip";
  import { frameChrome } from "./frame-chrome.store.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { PAGE_SOFT_ICON_BTN } from "../../lib/page-chrome";

  // The session sidebar keeps its toggle in one frame slot across both states.
  // The project panel still offers its frame control only when it is collapsed.
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
    onDarkSky = false,
  }: {
    variant: "sidebar" | "projectPanel";
    size?: "strip" | "header";
    onDarkSky?: boolean;
  } = $props();

  const visible = $derived(
    variant === "sidebar"
      ? !!frameChrome.toggleSidebar
      : import.meta.env.DEV &&
          !frameChrome.projectPanelOpen &&
          !!frameChrome.toggleProjectPanelFromFrame,
  );

  const label = $derived(
    variant === "sidebar"
      ? frameChrome.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"
      : "Expand project panel",
  );

  function togglePanel() {
    if (variant === "sidebar") frameChrome.toggleSidebar?.();
    else frameChrome.toggleProjectPanelFromFrame?.();
  }
</script>

{#if visible}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    class={variant === "sidebar"
      ? `no-drag pointer-events-auto inline-flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent transition-[color,opacity] hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current motion-reduce:transition-none pointer-coarse:tap-area ${onDarkSky
          ? "text-white"
          : "text-(--solus-text-primary)"}`
      : size === "header"
      ? PAGE_SOFT_ICON_BTN
      : "no-drag flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent p-0 text-(--solus-text-tertiary) transition-[color,background-color] duration-150 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-input-focus-border)"}
    onmousedown={(e) => e.stopPropagation()}
    onclick={togglePanel}
    aria-label={label}
    aria-expanded={variant === "sidebar" ? frameChrome.sidebarOpen : undefined}
  >
    <SidebarSimpleIcon
      size={size === "header" ? 15 : 13}
      strokeWidth={variant === "sidebar" ? 1.75 : size === "header" ? 1.5 : 2}
      mirrored={variant === "projectPanel"}
    />
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={`${label} (${comboHint(variant === "sidebar" ? "global.toggle-sidebar" : "global.toggle-project-panel")})`} />
  </TooltipUI.Root>
{/if}
