<script lang="ts">
  import { SidebarSimpleIcon, XIcon } from "phosphor-svelte";
  import { getWorkspaceContext, getSettingsContext } from "../../contexts";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import EditorInputCard from "../input/EditorInputCard.svelte";
  import ProjectPanel from "../project-panel/ProjectPanel.svelte";
  import ConversationView from "./ConversationView.svelte";
  import SessionBreadcrumb from "./SessionBreadcrumb.svelte";
  import { isHomeVisible } from "../layout/lib/workspace-body";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";

  let {
    params,
    paneId,
    surfaceVisible = true,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: RouteSurfaceProps<"chat"> = $props();

  const session = getWorkspaceContext();

  // A pinned chat always names its tab; the leading pane's chat renders through
  // the pool instead, so this component never sees the bare active-tab case.
  const tabId = $derived(params.tabId ?? session.activeTabId);

  // An empty split chat reads as the same headline-sitting-on-the-composer block
  // the leading column centres, not a hero stranded in the middle of a blank
  // transcript with the composer far below it.
  const centerHome = $derived(
    isHomeVisible(session.tabOrder.length, session.sessionFor(tabId)),
  );

  async function attachFile() {
    if (onAttachFile) {
      await onAttachFile(tabId);
      return;
    }
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0) return;
    session.addAttachments(files, tabId);
  }

  function toggleDiff() {
    session.toggleDiff(tabId);
  }

  // The rail is chrome of the conversation it describes, so a split chat carries
  // its own — scoped to its session, not the active tab's. It minimizes itself
  // when this pane is too narrow to hold both.
  const settings = getSettingsContext();
  let paneWidth = $state(0);

  function toggleRail() {
    settings.update({ splitProjectPanelOpen: !settings.splitProjectPanelOpen });
    requestInputFocus({ tabId });
  }

  function closeConversationTab() {
    session.closeTab(tabId);
    requestInputFocus();
  }
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col border-l border-(--solus-container-border) bg-(--solus-container-bg)"
  onfocusin={() => session.router.focusPane(paneId)}
  bind:clientWidth={paneWidth}
>
  <!-- The split tab already lives in the primary tab strip, but this pane still
       needs the same chrome row. Keeping the row preserves the shared vertical
       grid after the old titled header was removed: both transcripts begin and
       both composers end on the same lines. -->
  <div
    class="split-chat-chrome no-drag flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center justify-end gap-1 px-2.5"
  >
    <SessionBreadcrumb
      {tabId}
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
      onclick={closeConversationTab}
      aria-label="Close conversation tab"
    >
      <XIcon size={16} />
    </button>
  </div>

  <div class="flex min-h-0 min-w-0 flex-1">
    <div
      class="split-column flex min-h-0 min-w-0 flex-1 flex-col"
      class:justify-center={centerHome}
      class:home-measure={centerHome}
    >
      <div class="flex min-h-0 flex-col" class:flex-1={!centerHome}>
        <ConversationView {tabId} onDiffToggle={toggleDiff} forceVisible {surfaceVisible} />
      </div>

      <div class="split-input-dock shrink-0 px-4 pt-2.5 pb-2.5">
        <EditorInputCard
          class="mx-auto max-w-(--solus-reading-max)"
          {tabId}
          onAttachFile={attachFile}
          onScreenshot={onScreenshot ? () => onScreenshot(tabId) : null}
          onDesignMode={onDesignMode ? () => onDesignMode(tabId) : null}
        />
      </div>
    </div>

    <ProjectPanel
      {tabId}
      isSplit
      containerWidth={paneWidth}
      active={surfaceVisible}
      onCollapse={toggleRail}
    />
  </div>
</div>

<style>
  /* The same measure the leading column's home uses, so a split composer on an
     empty session is the width the user just came from — not the full-bleed
     transcript measure. */
  .split-column.home-measure {
    --solus-reading-max: clamp(40rem, 50%, 52rem);
  }
</style>
