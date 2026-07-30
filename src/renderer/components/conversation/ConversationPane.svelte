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

  interface Props {
    tabId: string;
    onAttachFile?: (tabId?: string) => void | Promise<void>;
    onScreenshot?: ((tabId?: string) => void | Promise<void>) | null;
    onDesignMode?: ((tabId?: string) => void | Promise<void>) | null;
  }
  let {
    tabId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: Props = $props();

  const session = getWorkspaceContext();
  const panes = session.panes;

  const splitSession = $derived(session.sessionFor(tabId));

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
    panes.toggleDiff(!!splitSession?.workingDirectory, tabId);
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
  onfocusin={() => panes.focusPane("secondary")}
  bind:clientWidth={paneWidth}
>
  <!-- The split tab already lives in the primary tab strip, but this pane still
       needs the same chrome row. Keeping the row preserves the shared vertical
       grid after the old titled header was removed: both transcripts begin and
       both composers end on the same lines. -->
  <div
    class="split-chat-chrome no-drag flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center justify-end gap-1 border-b border-[color-mix(in_srgb,var(--solus-container-border)_50%,transparent)] px-2.5"
  >
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class={PAGE_ICON_BTN}
            onclick={toggleRail}
            aria-label={settings.splitProjectPanelOpen
              ? "Collapse project panel"
              : "Expand project panel"}
          >
            <SidebarSimpleIcon size={13} mirrored />
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={`${settings.splitProjectPanelOpen ? "Collapse" : "Expand"} project panel (${comboHint("global.toggle-project-panel")})`}
      />
    </TooltipUI.Root>

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
    <div class="flex min-h-0 min-w-0 flex-1 flex-col pb-2">
      <div class="flex min-h-0 flex-1 flex-col">
        <ConversationView {tabId} onDiffToggle={toggleDiff} forceVisible />
      </div>

      <div class="split-input-dock shrink-0 px-4 pt-2.5 pb-3">
        <EditorInputCard
          class="mx-auto max-w-(--solus-reading-max)"
          {tabId}
          onAttachFile={attachFile}
          onScreenshot={onScreenshot ? () => onScreenshot(tabId) : null}
          onDesignMode={onDesignMode ? () => onDesignMode(tabId) : null}
        />
      </div>
    </div>

    <ProjectPanel {tabId} slot="secondary" containerWidth={paneWidth} />
  </div>
</div>
