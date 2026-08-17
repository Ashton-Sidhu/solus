<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    getWorkspaceContext,
    getSettingsContext,
    getWindowContext,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
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
  const windowCtx = getWindowContext();
  let paneWidth = $state(0);
  // A conversation can end up in the leading pane — "Ask Solus" beside a review
  // already showing in the companion puts it there, and so does moving a pane
  // across. This shell is then the leftmost surface, not one docked beside
  // another: it draws no seam of its own, and its row has to clear the frame's
  // own controls the way every other leading chrome row does.
  const isLeading = $derived(paneId === session.router.leadingPane.id);

  function toggleRail() {
    settings.update({ splitProjectPanelOpen: !settings.splitProjectPanelOpen });
    requestInputFocus(tabId ? { tabId } : undefined);
  }
</script>

<div
  class="flex h-full min-h-0 min-w-0 flex-col bg-(--solus-container-bg) {isLeading
 ? ''
 : 'border-l border-(--solus-container-border)'}"
  onfocusin={() => session.router.focusPane(paneId)}
  bind:clientWidth={paneWidth}
>
  <!-- A split tab already lives in the primary tab strip, but this pane still
       needs the same chrome row. Keeping the row preserves the shared vertical
       grid after the old titled header was removed: both transcripts begin and
       both composers end on the same lines. -->
  <div
    class="workspace-titlebar split-chat-chrome flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center justify-end gap-1 pr-2.5 pl-[max(0.625rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <SessionBreadcrumb
      tabId={tabId ?? ""}
      {draft}
      variant="inline"
      showNewSessionAction={false}
      showProjectPanelAction
      projectPanelOpen={settings.splitProjectPanelOpen}
      onProjectPanelToggle={toggleRail}
      {onClose}
      {closeLabel}
    />
  </div>

  <div class="flex min-h-0 min-w-0 flex-1">
    <div
      class="aside-column flex min-h-0 min-w-0 flex-1 flex-col"
      class:justify-center={centered}
    >
      {@render body()}
    </div>

    <ProjectPanel
      sourceId={tabId ?? draft?.id ?? ""}
      isSplit
      containerWidth={paneWidth}
      workspaceWidth={windowCtx.workAreaWidth}
      active={surfaceVisible}
      onCollapse={toggleRail}
    />
  </div>
</div>
