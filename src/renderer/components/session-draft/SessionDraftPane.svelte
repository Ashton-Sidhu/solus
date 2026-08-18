<script lang="ts">
  import {
    getWorkspaceContext,
    getSettingsContext,
  } from "../../contexts";
  import { projectDirLabel } from "../../lib/paths";
  import { homeGitDetails } from "../../lib/git-context";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { cn } from "../../lib/utils";
  import { startsWorktree } from "../../contexts/workspace/run-config";
  import type { PluginCommandsResult } from "../../../shared/types";
  import type { SessionDraft } from "../../contexts/workspace/session-draft.svelte";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import AsidePaneShell from "../layout/AsidePaneShell.svelte";
  import SolusTips from "../layout/SolusTips.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import InputBar from "../input/InputBar.svelte";
  import InputBarHeader from "../input/InputBarHeader.svelte";
  import InputToolbar from "../input/InputToolbar.svelte";
  import { draftPluginCommandScope } from "./lib/plugin-command-scope";
  import { draftModelSelection } from "./lib/draft-selection";

  let {
    params,
    paneId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: RouteSurfaceProps<"draft"> = $props();

  const session = getWorkspaceContext();
  const theme = getSettingsContext();

  // Send drops the draft the instant its session exists, but the bar is still
  // mid-send and goes on to clear the text it just dispatched. Its prompt is
  // the session's object by then, so those last writes land where they should —
  // holding the draft here only keeps it reachable until this surface unmounts.
  let sent = $state<SessionDraft | null>(null);
  const draft = $derived(session.sessionDrafts.get(params.draftId) ?? sent);
  // Beside another pane the composer needs the same seam a split chat draws;
  // in the leading pane it is the leftmost surface and draws none.
  const isAside = $derived(paneId !== session.router.leadingPane.id);

  // The project keeps its own name even when the session will run in a worktree
  // of it, so the label reads off the repo root rather than the checkout.
  const gitHome = $derived(
    homeGitDetails(
      draft?.run.workingDirectory ?? "~",
      draft?.run.gitContext ?? null,
      session.globalDefaults.gitContext,
    ),
  );
  const projectRoot = $derived(
    gitHome.projectRoot ?? draft?.run.workingDirectory ?? "~",
  );
  const projectName = $derived(
    projectDirLabel(projectRoot, session.staticInfo?.workspacePath),
  );
  // No project chosen yet — "build in ~?" names nothing, so the question drops
  // its object and the chip below does the choosing.
  const hasProject = $derived(projectName !== "~");

  // A draft has no session command cache. Load against the run selected in its
  // own model picker instead of borrowing commands from the active tab.
  let pluginCommands = $state<PluginCommandsResult>({ global: [], project: [] });
  let pluginCommandRequestSequence = 0;
  $effect(() => {
    const current = draft;
    if (!current) return;
    const scope = draftPluginCommandScope(
      current.run,
      theme.activeAgent,
      current.id,
      (workingDirectory, gitContext, sourceId) =>
        session.ctxForEnvironment(workingDirectory, gitContext, sourceId),
    );
    // Reading both values makes a picker change invalidate this request even
    // when two models belong to the same provider.
    const requestIdentity =
      `${scope.provider}\0${scope.modelId ?? ""}\0${scope.workingDirectory}`;
    const requestSequence = ++pluginCommandRequestSequence;
    pluginCommands = { global: [], project: [] };
    void session
      .apiForRun(current.run)
      .getPluginCommands(scope.workingDirectory, scope.context)
      .then((result) => {
        if (requestSequence !== pluginCommandRequestSequence) return;
        const latest = draft;
        if (!latest) return;
        const latestIdentity =
          `${latest.run.provider ?? theme.activeAgent}\0${latest.run.modelConfig.modelId ?? ""}\0${latest.run.workingDirectory}`;
        if (latestIdentity !== requestIdentity) return;
        pluginCommands = result;
      })
      .catch((error) => {
        if (requestSequence === pluginCommandRequestSequence)
          console.error("getPluginCommands failed", error);
      });
    return () => {
      if (requestSequence === pluginCommandRequestSequence)
        pluginCommandRequestSequence++;
    };
  });

  // A draft names a directory before anything has read it — and when the
  // project was opened on another host, only that host can read it. Until it
  // answers there is no checkout, so the chips that describe the destination
  // have nothing to show. Same step a tab takes when it moves to a project, so
  // it goes through the same call. Re-runs whenever the draft is pointed
  // somewhere new, because choosing a project clears the checkout it had.
  $effect(() => {
    const current = draft;
    const cwd = current?.run.workingDirectory;
    if (!current || current.run.gitContext || !cwd || cwd === "~") return;
    void session.refreshStartTarget(current.id, cwd, startsWorktree(current.run));
  });

  // The model chip's detached mode edits a plain selection rather than a
  // session's config — which is exactly what a draft has.
  const modelSelection = draftModelSelection(
    () => draft ?? null,
    () => session.defaultRunConfig.provider ?? theme.activeAgent,
  );

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
    const tabId = session.startSessionDraft(params.draftId, {
      via: "click",
      activate: !isAside,
    });
    if (!tabId) return false;
    const started = isAside ? session.sessionFor(tabId) : null;
    session.router.navigate(
      { name: "chat", params: started ? { sessionId: started.id } : {} },
      { target: paneId },
    );
    if (isAside) requestInputFocus({ tabId });
    return session.sendMessage(text, undefined, tabId);
  }

  /** Nothing has started, so there is no tab to close — the draft is dropped and
   *  the pane it was filling goes with it. */
  function discard() {
    session.discardSessionDraft(params.draftId);
    session.router.closePane(paneId);
    requestInputFocus();
  }

  async function attachFile() {
    if (onAttachFile) {
      await onAttachFile();
      return;
    }
    const files = await session.apiForRun(draft?.run).attachFiles(
      draft ? session.ctxForDirectory(draft.run.workingDirectory) : undefined,
    );
    if (!files || files.length === 0 || !draft) return;
    for (const file of files) draft.prompt.attachments.push(file);
  }
</script>

{#snippet composer(current: SessionDraft)}
  <!-- One question, then the composer. Everything a new session needs — project,
       task, model — sits on the bar directly below, so this stays a headline. -->
  <div
    class="draft-column relative flex h-full min-h-0 w-full flex-col items-center justify-center gap-5 px-6 py-3"
  >
    <h1
      class="max-w-[40rem] text-center text-pretty text-2xl font-medium leading-[1.25] text-(--solus-text-primary) lg:max-w-[52rem] lg:text-4xl"
    >
      {#if hasProject}
        What should we build in
        <span class="whitespace-nowrap"
          ><ProjectFavicon
            {projectRoot}
            class="mr-[0.22em] size-[0.8em] translate-y-[0.05em]"
          /><span
            class="underline decoration-dotted decoration-[color:var(--solus-text-tertiary)] underline-offset-[0.28em]"
            >{projectName}</span
          ></span
        >?
      {:else}
        What should we build?
      {/if}
    </h1>

    <div class="w-full max-w-(--solus-reading-max)">
      <!-- The same destination strip a pre-flight tab draws — project, where it
           runs, branch, task — addressed by the draft's id. -->
      <InputBarHeader sourceId={current.id} {paneId} />

      <div
        class={cn(
          "overflow-hidden rounded-2xl bg-(--solus-input-pill-bg) px-3 pb-3",
          "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]",
        )}
      >
        <!-- No session and no tab: the bar composes for nothing that exists yet,
             so Send goes through `dispatch`, which is what mints both. -->
        <InputBar
          mode="editor"
          sessionId={null}
          isPrimary={!isAside}
          {paneId}
          run={current.run}
          {pluginCommands}
          boundWorkId={current.boundWorkId}
          onUnbindWork={() => (current.boundWorkId = null)}
          bind:prompt={current.prompt}
          onDispatch={dispatch}
        >
          {#snippet leadingActions(savedPromptsControl)}
            <InputToolbar
              mode="editor"
              isPrimary={!isAside}
              run={current.run}
              onRun={(next) => (current.run = next)}
              selection={modelSelection}
              onAttachFile={attachFile}
              {onScreenshot}
              {onDesignMode}
              {savedPromptsControl}
            />
          {/snippet}
        </InputBar>
      </div>
    </div>

    <!-- Full-page draft only: the narrow split composer has its own chrome, so
         tips there would crowd it. Pinned near the bottom, out of the centered
         flow so the headline stays optically centered. -->
    {#if !isAside}
      <SolusTips class="absolute inset-x-0 bottom-6 mx-auto px-6" />
    {/if}
  </div>
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
      onOpenAsPage={() => session.router.movePane(paneId, -1)}
      onClose={discard}
      closeLabel="Discard draft"
    >
      {#snippet body()}{@render composer(draft)}{/snippet}
    </AsidePaneShell>
  {:else}
    {@render composer(draft)}
  {/if}
{/if}

<style>
  /* A session draft is one compact prompt surface, whether it fills the
     leading pane or sits beside a document. Keep one stable measure so opening
     Ask Solus cannot resize the bar. max-width still lets it contract when the
     pane itself is narrower than 52rem. */
  .draft-column {
    --solus-reading-max: 52rem;
  }
</style>
