<script lang="ts">
  import {
    getWorkspaceContext,
    runtime,
    serversStore,
  } from "../../contexts";
  import { projectDirLabel } from "../../lib/paths";
  import { isChat } from "@solus/contracts/chat";
  import { homeGitDetails } from "../../lib/git-context";
  import { cn } from "../../lib/utils";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import AsidePaneShell from "../layout/AsidePaneShell.svelte";
  import DraftComposer from "./DraftComposer.svelte";
  import ConnectHostPage from "./ConnectHostPage.svelte";
  import { draftHostGate, type GatedHost } from "./lib/host-gate";
  import { liveActivityClock } from "../../lib/shared-clock";
  import SolusTips from "../layout/SolusTips.svelte";
  import GetStartedList from "../onboarding/GetStartedList.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";

  let {
    params,
    paneId,
    surfaceVisible = true,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: RouteSurfaceProps<"draft"> = $props();

  const session = getWorkspaceContext();

  // Send drops the draft the instant its session exists, but the bar is still
  // mid-send and goes on to clear the text it just dispatched. Its prompt is
  // the session's object by then, so those last writes land where they should —
  // holding the draft here only keeps it reachable until this surface unmounts.
  let sent = $state<SessionDraft | null>(null);
  const draft = $derived(session.drafts.sessionDrafts.get(params.draftId) ?? sent);
  // Beside another pane the composer needs the same seam a split chat draws;
  // in the leading pane it is the leftmost surface and draws none.
  const isAside = $derived(paneId !== session.router.leadingPane.id);
  // A draft that is gone — dropped empty while its tab was put away with
  // another page's strip — has nothing to show, so its tab closes rather than
  // standing empty. The leading pane falls back to its home.
  $effect(() => {
    if (draft || !session.router.pane(paneId)) return;
    const draftId = params.draftId;
    if (isAside) {
      session.router.closeSurfacesWhere((ref) => ref.name === "draft" && ref.params.draftId === draftId);
    } else {
      session.router.closePane(paneId);
    }
  });
  let composerInput = $state<ReturnType<typeof DraftComposer> | null>(null);

  // A draft no host can run has no composer: the pane asks for a host instead
  // (docs/plans/draft-connect-host.md). The clock runs only while no host is
  // online, to end the reconnect grace and keep "last seen" current.
  const gatedHosts = $derived<GatedHost[]>(
    serversStore.executionServers.map((server) => ({
      ...server,
      offlineSince: serversStore.offlineSinceFor(server.id),
    })),
  );
  const hasOnlineHost = $derived(gatedHosts.some((host) => host.status === "online"));
  let now = $state(Date.now());
  $effect(() => {
    if (hasOnlineHost) return;
    return liveActivityClock.subscribe((value) => (now = value));
  });
  const hostGate = $derived(draftHostGate(gatedHosts, now));

  // A draft is its own routed surface, so it owns the focus transition into its
  // own composer. Address the mounted InputBar directly rather than broadcasting
  // a workspace focus request. The picker is the one valid temporary owner;
  // once it closes, the draft takes the caret.
  $effect(() => {
    const draftId = params.draftId;
    if (
      !surfaceVisible ||
      !draft ||
      session.ui.unifiedPickerOpen ||
      runtime.shouldSuppressFocus
    )
      return;
    const focusFrame = requestAnimationFrame(() => {
      if (
        surfaceVisible &&
        !session.ui.unifiedPickerOpen &&
        params.draftId === draftId &&
        session.drafts.sessionDrafts.has(draftId)
      ) {
        composerInput?.focus();
      }
    });
    return () => cancelAnimationFrame(focusFrame);
  });

  // The project keeps its own name even when the session will run in a worktree
  // of it, so the label reads off the repo root rather than the checkout.
  const gitHome = $derived(
    homeGitDetails(
      draft?.run.workingDirectory ?? "~",
      draft?.run.gitContext ?? null,
      null,
    ),
  );
  const projectRoot = $derived(
    gitHome.projectRoot ?? draft?.run.workingDirectory ?? "~",
  );
  const projectName = $derived(projectDirLabel(projectRoot));
  // A chat has no project to build in; "build in ~?" names nothing either. Both
  // drop the object, and only the chip below is left to do the choosing.
  const inChat = $derived(isChat(projectRoot));
  const hasProject = $derived(!inChat && projectName !== "~");
  // Only a headline click sets an external anchor. Closing clears it so the
  // next open from the input header uses the chip's own trigger.
  let projectPickerOpen = $state(false);
  let projectPickerAnchor = $state<HTMLButtonElement | null>(null);

  /**
   * Send is the moment a draft stops being one: the session is created, its tab
   * mounts, and this pane hands the pane back to the conversation pool. The
   * prompt object is carried into the new tab by `createSession`, so the text
   * the bar is about to clear is the same object the send reads.
   */
  function dispatch(text: string): boolean {
    if (!draft) return false;
    sent = draft;
    // Beside the leading pane the new session stays pinned here, so this pane
    // must name it and the pool must not take it: an unnamed chat route is the
    // pool's, which renders the active tab — the same conversation twice, and a
    // pane with no session of its own for its close button to let go of.
    // A lead is written with its task page beside it, and the draft's strip
    // goes with the session it starts.
    const tabId = session.drafts.startSessionDraft(params.draftId, {
      via: "click",
      activate: !isAside,
    });
    if (!tabId) return false;
    const started = isAside ? session.sessionFor(tabId) : null;
    session.router.navigate(
      { name: "chat", params: started ? { sessionId: started.id } : {} },
      { target: isAside ? "companion" : "leading", inPlace: true },
    );
    if (isAside) requestInputFocus({ tabId });
    return session.dispatch.sendMessage(text, undefined, tabId);
  }

  /**
   * ⌘Enter. The session starts where nothing can see it start — no activation,
   * no caret moved — and this pane takes a fresh draft aimed at the same
   * project, model and task, so the next prompt can be typed straight away.
   */
  function dispatchInBackground(text: string): boolean {
    if (!draft) return false;
    sent = draft;
    return session.drafts.startDraftInBackground(draft.id, text, isAside ? "companion" : "leading");
  }

  /** Nothing has started, so there is no tab to close — the draft is dropped and
   *  the pane it was filling goes with it. */
  function discard() {
    session.drafts.discardSessionDraft(params.draftId);
    requestInputFocus();
  }
</script>

{#snippet headline()}
  <!-- The headline is display type, not chrome, so it has no responsive rung.
       The question shares the bar's measure, so it is never wider than the
       composer under it on any display. -->
  <h1
    class="w-full text-center text-3xl leading-[1.25] font-normal tracking-tight text-pretty text-(--solus-text-primary)"
  >
    {#if hasProject}
      What should we build in
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={projectPickerOpen}
        aria-label="Change project — currently {projectName}"
        onclick={(event) => {
          projectPickerAnchor = event.currentTarget;
          projectPickerOpen = true;
        }}
        title={projectName}
        class="group inline-flex max-w-64 items-baseline align-baseline whitespace-nowrap focus-visible:outline-none"
        ><ProjectFavicon
          {projectRoot}
          serverId={draft?.run.serverId}
          class="mr-[0.22em] size-[0.8em] translate-y-[0.05em]"
        /><span
          class="min-w-0 overflow-x-clip text-ellipsis underline decoration-dotted decoration-[color:var(--solus-text-tertiary)] underline-offset-[0.28em] transition-[text-decoration-color] duration-[var(--duration-quick)] ease-(--ease-premium) group-hover:decoration-[color:var(--solus-text-secondary)] group-focus-visible:decoration-[color:var(--solus-accent)]"
          >{projectName}</span
        ></button
      >?
    {:else if inChat}
      What can I help with?
    {:else}
      What should we build?
    {/if}
  </h1>
{/snippet}

{#snippet composer(current: SessionDraft)}
  <!-- One question, then the composer. Everything a new session needs — project,
       task, model — sits on the bar directly below, so this stays a headline. -->
  <div class="relative flex h-full min-h-0 w-full flex-col items-center justify-center gap-5 px-6 py-3">
    <!-- The composer is what sits centred, at every width; the question rests
         on top of it rather than pushing it down, so the bar does not move as
         the headline wraps. The full-page new tab home is narrower than the
         conversation, so the empty page reads as one focused prompt — until
         60% would cramp the bar, when it takes up to 30rem of the pane. -->
    <div
      class={cn(
        "relative w-full",
        isAside ? "max-w-(--solus-reading-max)" : "max-w-[max(min(60%,50rem),min(100%,30rem))]",
      )}
    >
      <div class="absolute inset-x-0 bottom-full pb-4">{@render headline()}</div>
      <DraftComposer
        bind:this={composerInput}
        draft={current}
        {paneId}
        active={surfaceVisible}
        isPrimary={!isAside}
        spacious
        maxHeight={260}
        {projectPickerAnchor}
        bind:projectPickerOpen={
          () => projectPickerOpen,
          (open) => {
            projectPickerOpen = open;
            if (!open) projectPickerAnchor = null;
          }
        }
        onDispatch={dispatch}
        onDispatchInBackground={dispatchInBackground}
        {onAttachFile}
        {onScreenshot}
        {onDesignMode}
      />
    </div>

    <!-- What cloud onboarding asked and was skipped. Cloud only; renders nothing
         when setup is complete. -->
    {#if !isAside}
      <GetStartedList class="max-w-[max(min(60%,50rem),min(100%,30rem))]" />
    {/if}

    <!-- Full-page draft only: the narrow split composer has its own chrome, so
         tips there would crowd it. Pinned near the bottom, out of the centered
         flow so the headline stays optically centered. -->
    {#if !isAside}
      <SolusTips class="absolute inset-x-0 bottom-6 mx-auto px-6" />
    {/if}
  </div>
{/snippet}

{#snippet surface(current: SessionDraft)}
  {#if hostGate === "connect"}
    <ConnectHostPage
      hosts={gatedHosts}
      draftText={current.prompt.text.trim()}
      {surfaceVisible}
      compact={isAside}
      {now}
    />
  {:else}
    {@render composer(current)}
  {/if}
{/snippet}

{#if draft}
  {#if isAside}
    <!-- Beside another pane the draft is a surface among surfaces, so it carries
         the same header a split chat does — where it will run, its rail, and the
         way out. In the leading pane that chrome is the workspace's own. -->
    <AsidePaneShell
      {paneId}
      {draft}
      centered
      onOpenAsPage={() => {
        const companion = session.router.companionPane;
        if (companion) session.router.moveSurfaceToMain(companion.activeSurfaceIndex);
      }}
      onClose={discard}
      closeLabel="Discard draft"
    >
      {#snippet body()}{@render surface(draft)}{/snippet}
    </AsidePaneShell>
  {:else}
    {@render surface(draft)}
  {/if}
{/if}
