<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    getWorkspaceContext,
    hostCapabilitiesStore,
    serversStore,
  } from "../../contexts";
  import type { RunConfig } from "@solus/contracts/types";
  import type { PickerSelection } from "../pickers/lib/picker-selection";
  import AddFilesButton from "./AddFilesButton.svelte";
  import PermissionModePicker from "../pickers/PermissionModePicker.svelte";
  import SessionChip from "../pickers/SessionChip.svelte";
  import StatusBarControls from "../layout/StatusBarControls.svelte";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { unsupportedOnHost } from "@solus/client-core/host-capabilities";
  import { serverConnections } from "@solus/client-core/server-connections";

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

  The row is a declared disclosure ladder against the `composer` container, not a
  flexbox negotiation. Flexbox decides who shrinks and it decides badly: the
  model chip used to shrink past its own glyphs and paint over its neighbour
  while the send button was pushed off the card edge and clipped.

  Floor = text well + mic + send ≈ 9rem. Below it the composer is absent, not
  degraded, which is why mic and send appear in no rung here and must never be
  added to one — they are the reverse-state guarantee that you can always send
  and always stop dictating. Rungs, widest first:

    ≥ 38rem  everything
    < 38rem  saved-prompts control          (this file)
    < 34rem  context usage meter            (StatusBarControls)
    < 31rem  reasoning label on the chip    (SessionChip)
    < 28rem  permission picker → icon-only  (PermissionModePicker)
    < 25rem  status cluster                 (this file)
    < 22rem  model chip → brand glyph only  (SessionChip)

  The ladder opens higher than the row strictly needs, but not by much. It used
  to start at 30rem, which is already past the width where the meter paints over
  the mic — a rung that fires after the collision it exists to prevent is
  decoration. The meter is the rung to keep honest: 34rem is the first width at
  which it can leave without the row having looked crowded first, and everything
  else is spaced back from it.

  The two pickers shed their labels well before the row is in trouble: a chip
  whose glyph already says which mode and which model is on spends nothing by
  dropping the word beside it, and the width it returns is what keeps the
  project and branch chips readable a rung longer.

  Every rung hides; none unmounts. A control that unmounts loses its state and
  pays a re-mount on every frame of a pane drag. The same ladder serves Editor
  mode, Pill mode and the phone unchanged, because a container query does not
  care why it got narrow.
-->
<div
  class="flex flex-1 min-w-0 items-center gap-2 {mode === 'editor'
    ? 'editor-input-toolbar text-workspace-chrome [&_button]:text-[length:inherit]'
    : ''}"
>
  <AddFilesButton
    {onAttachFile}
    {onScreenshot}
    {onDesignMode}
    disabled={isRunning}
    attachDisabled={!canAttachFiles}
    {attachTooltip}
  />
  <PermissionModePicker {tabId} {isPrimary} {run} {onRun} />
  <SessionChip {tabId} {isPrimary} bind:selection returnFocusOnClose />
  <!-- Rung 1. Wrapped rather than hidden in place: the control is a snippet the
       bar owns, so the rung has to live on a box this row controls. `contents`
       generates no box of its own, so Pill mode — which passes no snippet — does
       not pay an empty flex item and its `gap-2` here. -->
  <div class="contents @max-[38rem]/composer:hidden">
    {@render savedPromptsControl?.()}
  </div>

  <!-- Rungs 2 and 5 live inside StatusBarControls, which hides its own readouts and
       keeps `trailingActions` — connection retry, push bell, Switch server on
       web — reachable at every width. `ml-auto` is inert once a row overflows,
       which is why the ladder acts before the row can overflow, not after. -->
  <div class="ml-auto flex min-w-0 items-center">
    <StatusBarControls
      {mode}
      sourceId={tabId ?? draftId}
      {isPrimary}
      {trailingActions}
    />
  </div>
</div>

<style>
  /* Editor controls keep the 14px chrome rung on laptops. Their fixed-size
     glyphs receive the same two-pixel lift without changing larger displays. */
  @media (pointer: fine) {
    :global(html.is-laptop-display)
      .editor-input-toolbar
      :global(svg[width="9"]) {
      width: 11px;
      height: 11px;
    }

    :global(html.is-laptop-display)
      .editor-input-toolbar
      :global(svg[width="11"]) {
      width: 13px;
      height: 13px;
    }

    :global(html.is-laptop-display)
      .editor-input-toolbar
      :global(svg[width="13"]) {
      width: 15px;
      height: 15px;
    }

    :global(html.is-laptop-display)
      .editor-input-toolbar
      :global(svg[width="14"]) {
      width: 16px;
      height: 16px;
    }

    :global(html.is-laptop-display)
      .editor-input-toolbar
      :global(svg[width="15"]) {
      width: 17px;
      height: 17px;
    }
  }
</style>
