<script lang="ts">
  import { SidebarSimpleIcon } from "phosphor-svelte";
  import { tooltip } from "../../lib/tooltip";
  import { frameChrome } from "../../contexts/frame-chrome.store.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";

  // `sidebar` expands the collapsed session sidebar; `projectPanel` expands the
  // dev-only project panel. Each renders only when its panel is collapsed and a
  // toggle has been registered by EditorLayout (so it stays hidden in pill mode
  // and on views that don't host the frame chrome).
  //
  // The button renders inline so page headers can align it with their content
  // gutters and keep the adjacent title/actions in the same visual column.
  let { variant }: { variant: "sidebar" | "projectPanel" } = $props();

  const visible = $derived(
    variant === "sidebar"
      ? !frameChrome.sidebarOpen && !!frameChrome.expandSidebar
      : import.meta.env.DEV &&
          !frameChrome.projectPanelOpen &&
          !!frameChrome.expandProjectPanel,
  );

  function expand() {
    if (variant === "sidebar") frameChrome.expandSidebar?.();
    else frameChrome.expandProjectPanel?.();
  }
</script>

{#if visible}
  <button
    type="button"
    class="no-drag flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] border-0 bg-transparent p-0 text-(--solus-text-tertiary) transition-[color,background-color] duration-150 ease-in-out hover:bg-[color-mix(in_srgb,var(--solus-text-primary)_6%,transparent)] hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--solus-input-focus-border)"
    onmousedown={(e) => e.stopPropagation()}
    onclick={expand}
    use:tooltip={variant === "sidebar"
      ? `Expand sidebar (${comboHint("global.toggle-sidebar")})`
      : `Expand project panel (${comboHint("global.toggle-project-panel")})`}
    aria-label={variant === "sidebar"
      ? "Expand sidebar"
      : "Expand project panel"}
  >
    <SidebarSimpleIcon size={13} mirrored={variant === "projectPanel"} />
  </button>
{/if}
