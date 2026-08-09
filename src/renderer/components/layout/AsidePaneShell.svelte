<script lang="ts">
  import type { Snippet } from "svelte";
  import { SidebarSimpleIcon, XIcon } from "phosphor-svelte";
  import { getWorkspaceContext, getSettingsContext } from "../../contexts";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import ProjectPanel from "../project-panel/ProjectPanel.svelte";
  import SessionBreadcrumb from "../conversation/SessionBreadcrumb.svelte";
  import type { PaneId } from "../../contexts/workspace/routing/location";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";

  /**
   * The chrome a pane beside the leading one draws around a conversation or a
   * draft: the band that says where you are, the project rail, and the way out.
   * Both surfaces need the identical header, so it is defined once here rather
   * than per surface — a surface that forgets its own header is bare with no
   * error to say so, which is exactly how the draft pane shipped without one.
   *
   * The leading pane's equivalent is assembled by `WorkspaceBody`, because there
   * the band floats over a transcript the pool owns rather than sitting in a row.
   */
  interface Props {
    paneId: PaneId;
    /** The conversation this pane holds, once one has started. */
    tabId?: string;
    /** The draft it holds instead, before one has. Exactly one of the two. */
    draft?: SessionDraft | null;
    /** Centre the body as one block: an empty session and a draft are both a
     *  headline sitting on a composer, not a transcript with a floor. */
    centered?: boolean;
    /** False while the owning surface is mounted but hidden. */
    surfaceVisible?: boolean;
    onClose: () => void;
    closeLabel: string;
    body: Snippet;
  }

  let {
    paneId,
    tabId,
    draft = null,
    centered = false,
    surfaceVisible = true,
    onClose,
    closeLabel,
    body,
  }: Props = $props();

  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  let paneWidth = $state(0);

  function toggleRail() {
    settings.update({ splitProjectPanelOpen: !settings.splitProjectPanelOpen });
    requestInputFocus(tabId ? { tabId } : undefined);
  }
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
  onfocusin={() => session.router.focusPane(paneId)}
  bind:clientWidth={paneWidth}
>
  <!-- A split tab already lives in the primary tab strip, but this pane still
       needs the same chrome row. Keeping the row preserves the shared vertical
       grid after the old titled header was removed: both transcripts begin and
       both composers end on the same lines. -->
  <div
    class="split-chat-chrome no-drag flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center justify-end gap-1 px-2.5"
  >
    <SessionBreadcrumb
      tabId={tabId ?? ""}
      {draft}
      variant="inline"
      showNewSessionAction={false}
      showProjectPanelAction={false}
    />

    {#if !settings.splitProjectPanelOpen}
      <TooltipUI.Root>
        <TooltipUI.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class={PAGE_ICON_BTN}
              onclick={toggleRail}
              aria-label="Expand project panel"
            >
              <SidebarSimpleIcon size={13} mirrored />
            </button>
          {/snippet}
        </TooltipUI.Trigger>
        <TooltipUI.Content
          value={`Expand project panel (${comboHint("global.toggle-project-panel")})`}
        />
      </TooltipUI.Root>
    {/if}

    <button
      type="button"
      class={PAGE_ICON_BTN}
      onclick={onClose}
      aria-label={closeLabel}
    >
      <XIcon size={16} />
    </button>
  </div>

  <div class="flex min-h-0 min-w-0 flex-1">
    <div
      class="aside-column flex min-h-0 min-w-0 flex-1 flex-col"
      class:justify-center={centered}
      class:home-measure={centered}
    >
      {@render body()}
    </div>

    <ProjectPanel
      sourceId={tabId ?? draft?.id ?? ""}
      isSplit
      containerWidth={paneWidth}
      active={surfaceVisible}
      onCollapse={toggleRail}
    />
  </div>
</div>

<style>
  /* The same measure the leading column's home uses, so a composer beside a
     thread is the width the user just came from — not the full-bleed
     transcript measure. */
  .aside-column.home-measure {
    --solus-reading-max: clamp(40rem, 50%, 52rem);
  }
</style>
