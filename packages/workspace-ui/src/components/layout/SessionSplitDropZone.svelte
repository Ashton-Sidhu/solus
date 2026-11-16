<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { carriesSessionDrag, readSessionDrag } from "../../lib/session-drag";
  import { toasts } from "../../lib/toasts";
  import { sessionSplitDropZone, type Span } from "./lib/session-split-drop";

  interface Props {
    /** The destination and the companion pane together. */
    split: HTMLElement | null;
    /** The companion pane, when it is open. */
    companion: HTMLElement | null;
    enabled: boolean;
  }

  let { split, companion, enabled }: Props = $props();

  const session = getWorkspaceContext();

  /** Where a session drag would open, relative to the split. */
  let zone = $state<{ left: number; width: number } | null>(null);
  const companionOpen = $derived(!!companion);

  function zoneUnder(event: DragEvent, element: HTMLElement): Span | null {
    const bounds = element.getBoundingClientRect();
    return sessionSplitDropZone(event.clientX, bounds, companion?.getBoundingClientRect() ?? null);
  }

  // A session dragged from the sidebar past the middle of the workspace opens
  // beside the destination, or as one more surface when the companion pane is
  // open. A composer under the pointer takes the drag first, as a chip.
  $effect(() => {
    const element = split;
    if (!element || !enabled) return;
    const over = (event: DragEvent) => {
      const target =
        event.defaultPrevented || !carriesSessionDrag(event.dataTransfer) ? null : zoneUnder(event, element);
      if (!target) {
        zone = null;
        return;
      }
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
      const left = target.left - element.getBoundingClientRect().left;
      if (zone?.left !== left || zone.width !== target.right - target.left) {
        zone = { left, width: target.right - target.left };
      }
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
      zone = null;
    };
    const drop = (event: DragEvent) => {
      zone = null;
      if (event.defaultPrevented || !zoneUnder(event, element)) return;
      const references = readSessionDrag(event.dataTransfer);
      if (references.length === 0) return;
      event.preventDefault();
      session
        .openSessionsAsSurfaces(references)
        .then((opened) => {
          if (opened === 0) toasts.error("Couldn't open the session beside this one");
        })
        .catch((error) => {
          toasts.error("Couldn't open the session beside this one", {
            description: error instanceof Error ? error.message : String(error),
          });
        });
    };
    const end = () => (zone = null);
    element.addEventListener("dragover", over);
    element.addEventListener("dragleave", leave);
    element.addEventListener("drop", drop);
    window.addEventListener("dragend", end);
    return () => {
      element.removeEventListener("dragover", over);
      element.removeEventListener("dragleave", leave);
      element.removeEventListener("drop", drop);
      window.removeEventListener("dragend", end);
      zone = null;
    };
  });
</script>

{#if zone}
  <!-- The companion card's own frame: its pane slot spends the gutter on the
       top, right, and bottom, and the leading column's gutter is the gap on
       its left. See `.secondary-pane-wrap` in WorkspaceBody. -->
  <div
    class="pointer-events-none absolute top-(--solus-pane-gutter) bottom-(--solus-pane-gutter) z-30 flex items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--solus-container-border)_85%,transparent)] bg-[color-mix(in_oklch,#fffffe_55%,transparent)] shadow-[0_1px_2px_rgba(42,38,24,0.03),0_8px_24px_-12px_rgba(42,38,24,0.08)] dark:border-[color-mix(in_srgb,var(--solus-text-primary)_11%,transparent)] dark:bg-[color-mix(in_oklch,color-mix(in_oklch,white_4%,#262522)_55%,transparent)] dark:shadow-none"
    style="left:{zone.left}px; width:calc({zone.width}px - var(--solus-pane-gutter))"
    aria-hidden="true"
  >
    <span class="text-workspace-chrome font-medium text-(--solus-text-secondary)">
      {companionOpen ? "Add to Split" : "Open in Split"}
    </span>
  </div>
{/if}
