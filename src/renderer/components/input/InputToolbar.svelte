<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    getWorkspaceContext,
    hostCapabilitiesStore,
    serversStore,
  } from "../../contexts";
  import type { RunConfig } from "../../../shared/types";
  import type { PickerSelection } from "../pickers/lib/picker-selection";
  import AddFilesButton from "./AddFilesButton.svelte";
  import PermissionModePicker from "../pickers/PermissionModePicker.svelte";
  import SessionChip from "../pickers/SessionChip.svelte";
  import StatusBarControls from "../layout/StatusBarControls.svelte";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { unsupportedOnHost } from "@client-core/host-capabilities";
  import { serverConnections } from "@client-core/server-connections";

  interface Props {
    mode?: "pill" | "editor";
    /** The tab whose session these controls edit. Unset by a composer with no
     *  session yet, which supplies `run`/`onRun`/`selection` instead — the
     *  controls then edit that draft rather than borrowing the active tab's. */
    tabId?: string;
    /** This row belongs to the workspace's own composer, so dismissing a menu
     *  returns focus to it. */
    isPrimary?: boolean;
    /** The session draft these controls compose for, when there is no tab yet.
     *  The destination cluster is addressed by it, so it names the draft's own
     *  project, host, and branch rather than the workspace defaults. */
    draftId?: string;
    /** A session draft's run and the model selection over it. */
    run?: RunConfig;
    onRun?: (next: RunConfig) => void;
    selection?: PickerSelection;
    onAttachFile: () => void;
    onScreenshot?: (() => void) | null;
    onDesignMode?: (() => void) | null;
    /** The bar's saved-prompts control, seated with the pickers it belongs with. */
    savedPromptsControl?: Snippet;
    /** Extra controls appended to the right cluster (web: push bell, logout). */
    trailingActions?: Snippet;
  }
  let {
    mode = "pill",
    tabId,
    draftId,
    isPrimary = false,
    run,
    onRun,
    selection = $bindable(),
    onAttachFile,
    onScreenshot,
    onDesignMode,
    savedPromptsControl,
    trailingActions,
  }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(tabId ? session.sessionFor(tabId) : undefined);
  const isRunning = $derived(
    sess?.status === "running" || sess?.status === "connecting",
  );
  const serverId = $derived(sess?.run.serverId ?? run?.serverId ?? LOCAL_SERVER_ID);
  const hostLabel = $derived(
    serversStore.hostFor(serverId)?.label ??
      serverConnections.connectionFor(serverId)?.target.label ??
      "this host",
  );
  const hostCapabilities = $derived(hostCapabilitiesStore.for(serverId));
  const canAttachFiles = $derived(hostCapabilities?.attachUpload === true);
  const attachTooltip = $derived(
    hostCapabilities === undefined
      ? "Checking file attachment support…"
      : canAttachFiles
        ? "Attach file (⌥⇧A)"
        : unsupportedOnHost("File attachments", hostLabel),
  );

  $effect(() => {
    void hostCapabilitiesStore.load(serverId);
  });
</script>

<!--
  Single input-bar toolbar row: add-files + mode + model pills on the left, the
  project/server cluster pushed right (before the bar's mic/send). Fed to
  InputBar via its `leadingActions` slot so it shares the row with mic/send.
-->
<div class="flex flex-1 min-w-0 items-center gap-2">
  <AddFilesButton
    {onAttachFile}
    {onScreenshot}
    {onDesignMode}
    disabled={isRunning}
    attachDisabled={!canAttachFiles}
    {attachTooltip}
  />
  <PermissionModePicker {tabId} {isPrimary} {run} {onRun} />
  <SessionChip {tabId} {isPrimary} bind:selection />
  {@render savedPromptsControl?.()}

  <div class="ml-auto flex min-w-0 items-center">
    <StatusBarControls
      {mode}
      sourceId={tabId ?? draftId}
      {isPrimary}
      {trailingActions}
    />
  </div>
</div>
