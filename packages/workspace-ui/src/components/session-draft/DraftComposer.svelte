<script lang="ts">
  import type { Snippet } from "svelte";
  import type { PromptDelivery } from "@solus/contracts/types";
  import { getSettingsContext, getWorkspaceContext } from "../../contexts";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import type { PaneSurfaceProps } from "../ui/lib/pane-surface";
  import InputBar from "../input/InputBar.svelte";
  import InputBarHeader from "../input/InputBarHeader.svelte";
  import InputToolbar from "../input/InputToolbar.svelte";
  import SeatNeededNotice from "../seats/SeatNeededNotice.svelte";
  import { cn } from "../../lib/utils";
  import { draftModelSelection } from "./lib/draft-selection";
  import { useDraftPreflight } from "./lib/draft-preflight.svelte";

  /**
   * The composer a session draft is written in: where it will run, the seat it
   * still needs, and the bar with its pickers. Every surface that composes a
   * draft renders this — the draft pane, and the composer docked on a page — so
   * the destination strip, the toolbar and the slash commands are
   * the same wherever a new session starts.
   */
  interface Props extends Pick<PaneSurfaceProps, "onAttachFile" | "onScreenshot" | "onDesignMode"> {
    draft: SessionDraft;
    paneId: string;
    active: boolean;
    /** The workspace's own composer: it takes app-level focus and the mic. */
    isPrimary: boolean;
    spacious?: boolean;
    /** Over a page rather than on a pane of its own: the card lifts off the
     *  page with a shadow. */
    floating?: boolean;
    /** The surface decides where the session runs, so the strip that would
     *  offer to change it is not drawn. */
    destinationFixed?: boolean;
    maxHeight?: number;
    idlePlaceholder?: string;
    onDispatch: (text: string, delivery: PromptDelivery) => boolean;
    onDispatchInBackground?: (text: string) => boolean;
    onSent?: () => void;
    /** Bound where a surface above the strip names the project as well. */
    projectPickerOpen?: boolean;
    projectPickerAnchor?: HTMLElement | null;
  }
  let {
    draft,
    paneId,
    active,
    isPrimary,
    spacious = false,
    floating = false,
    destinationFixed = false,
    maxHeight,
    idlePlaceholder,
    onDispatch,
    onDispatchInBackground,
    onSent,
    projectPickerOpen = $bindable(false),
    projectPickerAnchor = null,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: Props = $props();

  const session = getWorkspaceContext();
  const theme = getSettingsContext();
  let composerInput = $state<ReturnType<typeof InputBar> | null>(null);

  const preflight = useDraftPreflight(() => draft);
  // The model chip's detached mode edits a plain selection rather than a
  // session's config — which is exactly what a draft has.
  const modelSelection = draftModelSelection(
    () => draft,
    () => session.defaultRunConfig.provider ?? theme.activeAgent,
  );

  export function focus() {
    composerInput?.focus();
  }

  async function attachFile() {
    // The shell's own picker files the upload in the draft's folder.
    if (onAttachFile) {
      await onAttachFile(draft.id);
      return;
    }
    const current = draft;
    const files = await session
      .apiForRun(current.run)
      .attachFiles(session.ctxForDirectory(current.run.workingDirectory));
    for (const file of files ?? []) current.prompt.attachments.push(file);
  }
</script>

<!-- The same destination strip a pre-flight tab draws — project, where it
     runs, branch, task — addressed by the draft's id. -->
{#if !destinationFixed}
  <InputBarHeader
    {active}
    sourceId={draft.id}
    {paneId}
    {projectPickerAnchor}
    bind:projectPickerOpen
  />
{/if}

{#if draft.run.serverId}
  <!-- Before the first send, on a host that runs turns on the member's own
       seat: the seat this draft's agent still needs there. -->
  <SeatNeededNotice
    serverId={draft.run.pendingHostDispatch?.serverId ?? draft.run.serverId}
    provider={draft.run.provider ?? session.defaultRunConfig.provider ?? theme.activeAgent}
  />
{/if}

<div
  class={cn(
    "@container/composer overflow-hidden rounded-3xl bg-(--solus-input-pill-bg) px-3 pb-3",
    // Over a page the card lifts off it; on a pane it rests with a soft drop
    // in light mode and on its ring alone in dark.
    floating
      ? "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border),0_8px_32px_color-mix(in_oklch,var(--foreground)_12%,transparent)]"
      : "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border),0_12px_28px_-18px_rgb(0_0_0/40%)] dark:shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]",
  )}
>
  <!-- No session and no tab: the bar composes for nothing that exists yet, so
       Send goes through `onDispatch`, which is what mints both. -->
  <InputBar
    bind:this={composerInput}
    {active}
    {spacious}
    {maxHeight}
    sessionId={null}
    {isPrimary}
    {paneId}
    run={draft.run}
    onRun={(next) => (draft.run = next)}
    draftId={draft.id}
    pluginCommands={preflight.pluginCommands}
    boundWorkId={draft.boundWorkId}
    onUnbindWork={() => (draft.boundWorkId = null)}
    collapseWhenIdle={false}
    {idlePlaceholder}
    bind:prompt={draft.prompt}
    {onDispatch}
    {onDispatchInBackground}
    {onSent}
  >
    {#snippet leadingActions()}
      <InputToolbar
        {active}
        {spacious}
        showDestination={false}
        {isPrimary}
        run={draft.run}
        onRun={(next) => (draft.run = next)}
        selection={modelSelection}
        onAttachFile={attachFile}
        {onScreenshot}
        {onDesignMode}
      />
    {/snippet}
  </InputBar>
</div>
