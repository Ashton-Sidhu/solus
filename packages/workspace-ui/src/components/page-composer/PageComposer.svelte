<script lang="ts">
  import { onDestroy } from "svelte";
  import { getWorkspaceContext } from "../../contexts";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import type { CreateTabOptions } from "../../contexts/workspace/workspace.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { PaneSurfaceProps } from "../ui/lib/pane-surface";
  import FloatingComposer from "../ui/floating-composer/FloatingComposer.svelte";
  import DraftComposer from "../session-draft/DraftComposer.svelte";

  /**
   * A page's way to start an agent on it: one chat glyph docked at the foot of
   * the page, which opens into the same composer a new session gets. Send turns
   * the draft into a session and pops its conversation out beside the page.
   */
  interface Props extends Pick<PaneSurfaceProps, "onAttachFile" | "onScreenshot"> {
    /** The pane the page fills. Its composer is this one. */
    paneId: string;
    /** What the draft is aimed at: the work it binds, the host it runs on. */
    aim: CreateTabOptions;
    /** The project the draft starts in, when the page has one. */
    cwd?: string;
    /** How the started session gets its first prompt when the page has work to
     *  finish first — a pull request's checkout, shown in the conversation as
     *  it runs. Without it the prompt is sent at once. */
    sendFirstPrompt?: (tabId: string, text: string) => void;
    /** The page decides where the session runs — a work's own project, a pull
     *  request's worktree — so the composer offers no project or host. */
    destinationFixed?: boolean;
    label?: string;
    /** Where the folded glyph docks, when the page has its own bar at its
     *  foot for the glyph to line up with. */
    class?: string;
  }
  let {
    paneId,
    aim,
    cwd,
    sendFirstPrompt,
    destinationFixed = false,
    label = "Work with this page",
    class: glyphClass,
    onAttachFile,
    onScreenshot,
  }: Props = $props();

  const session = getWorkspaceContext();

  // The draft the page holds: the one the next Send starts, or null once it has.
  let draft = $state.raw<SessionDraft | null>(null);
  // The draft on screen. Send and fold let go of `draft` while the bar is still
  // clearing the text it sent and the composer is still scaling away, and
  // both read the draft they were given until they are gone — so the rendered
  // one is held apart, the way the draft pane holds its `sent` draft.
  let shown = $state.raw<SessionDraft | null>(null);
  let expanded = $state(false);
  let composerInput = $state<ReturnType<typeof DraftComposer> | null>(null);
  // Folded with words still in it, the glyph says so.
  const hasUnsent = $derived(!!draft && !draft.isEmpty);

  function expand() {
    draft ??= session.drafts.openDockedDraft({ ...aim, via: "click" }, cwd);
    shown = draft;
  }

  function fold() {
    expanded = false;
    if (draft?.isEmpty) {
      session.drafts.undockDraft(draft.id);
      draft = null;
    }
  }

  // A written-in draft outlives the page: the sidebar lists it.
  onDestroy(() => {
    if (draft) session.drafts.undockDraft(draft.id);
  });

  /** The draft becomes a session, and its conversation opens beside the page. */
  function start(current: SessionDraft, text: string): string | null {
    const besidePage = session.hasCompanionPanes;
    const tabId = session.drafts.startSessionDraft(current.id, { via: "click", activate: !besidePage });
    if (!tabId) return null;
    draft = null;
    const started = session.sessionFor(tabId);
    if (besidePage) {
      if (started) session.openChatSurface(started.id);
      requestInputFocus({ tabId });
    } else {
      session.router.closePane(paneId);
    }
    if (sendFirstPrompt) {
      sendFirstPrompt(tabId, text);
      return tabId;
    }
    return session.dispatch.sendMessage(text, undefined, tabId) ? tabId : null;
  }

  function dispatch(text: string): boolean {
    const current = draft;
    return !!current && start(current, text) !== null;
  }
</script>

<FloatingComposer
  bind:expanded
  {label}
  {hasUnsent}
  class={glyphClass}
  onExpand={expand}
  onFold={fold}
  onOpened={() => composerInput?.focus()}
>
  {#if shown}
    <DraftComposer
      bind:this={composerInput}
      draft={shown}
      {paneId}
      active
      isPrimary={false}
      floating
      {destinationFixed}
      maxHeight={200}
      idlePlaceholder={`${label}…`}
      onDispatch={dispatch}
      onSent={() => (expanded = false)}
      {onAttachFile}
      {onScreenshot}
    />
  {/if}
</FloatingComposer>
