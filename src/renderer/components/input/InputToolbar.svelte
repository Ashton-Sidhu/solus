<script lang="ts">
  import type { Snippet } from "svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import AddFilesButton from "./AddFilesButton.svelte";
  import PermissionModePicker from "../pickers/PermissionModePicker.svelte";
  import SessionChip from "../pickers/SessionChip.svelte";
  import StatusBarControls from "../layout/StatusBarControls.svelte";

  interface Props {
    mode?: "pill" | "editor";
    tabId?: string;
    onAttachFile: () => void;
    onScreenshot?: (() => void) | null;
    onDesignMode?: (() => void) | null;
    dirMaxWidth?: number;
    /** Extra controls appended to the right cluster (web: push bell, logout). */
    trailingActions?: Snippet;
  }
  let {
    mode = "pill",
    tabId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
    dirMaxWidth = 240,
    trailingActions,
  }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId ?? session.activeTabId));
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
</script>

<!--
  Single input-bar toolbar row: add-files + mode + model pills on the left, the
  project/usage/server cluster pushed right (before the bar's mic/send). Fed to
  InputBar via its `leadingActions` slot so it shares the row with mic/send.
-->
<div class="flex flex-1 min-w-0 items-center gap-2 px-1">
  <AddFilesButton
    {onAttachFile}
    {onScreenshot}
    {onDesignMode}
    disabled={isRunning}
  />
  <PermissionModePicker {tabId} />
  <SessionChip {tabId} />

  <div class="ml-auto flex min-w-0 items-center">
    <StatusBarControls {mode} {tabId} {dirMaxWidth} {trailingActions} />
  </div>
</div>
