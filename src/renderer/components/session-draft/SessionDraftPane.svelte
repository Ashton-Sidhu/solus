<script lang="ts">
  import { getWorkspaceContext } from "../../contexts";
  import { projectDirLabel } from "../../lib/paths";
  import { homeGitDetails } from "../../lib/git-context";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { cn } from "../../lib/utils";
  import { withCheckout } from "../../contexts/workspace/run-config";
  import type { TaskTarget } from "../../../shared/types";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import ProjectChip from "../input/ProjectChip.svelte";
  import TaskPicker from "../input/TaskPicker.svelte";
  import InputBar from "../input/InputBar.svelte";
  import InputToolbar from "../input/InputToolbar.svelte";

  let {
    params,
    paneId,
    onAttachFile,
    onScreenshot,
    onDesignMode,
  }: RouteSurfaceProps<"draft"> = $props();

  const session = getWorkspaceContext();
  const draft = $derived(session.sessionDrafts.get(params.draftId));

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

  function focusComposer() {
    requestInputFocus();
  }

  function selectProject(path: string) {
    if (!draft) return;
    draft.run = withCheckout(draft.run, path, null);
    void session.environment.refresh(path);
    focusComposer();
  }

  function browseProjects() {
    window.dispatchEvent(
      new CustomEvent("solus:open-directory-picker", {
        detail: { draftId: params.draftId },
      }),
    );
  }

  function selectTask(next: TaskTarget) {
    if (draft) draft.task = next;
  }

  /**
   * Send is the moment a draft stops being one: the session is created, its tab
   * mounts, and this pane hands the pane back to the conversation pool. The
   * prompt object is carried into the new tab by `createSession`, so the text
   * the bar is about to clear is the same object the send reads.
   */
  function dispatch(text: string): boolean {
    if (!draft) return false;
    const tabId = session.startSessionDraft(params.draftId, { via: "click" });
    if (!tabId) return false;
    session.router.navigate({ name: "chat", params: {} }, { target: paneId });
    return session.sendMessage(text, undefined, tabId);
  }

  async function attachFile() {
    if (onAttachFile) {
      await onAttachFile();
      return;
    }
    const files = await window.solus.attachFiles();
    if (!files || files.length === 0 || !draft) return;
    for (const file of files) draft.prompt.attachments.push(file);
  }
</script>

{#if draft}
  <!-- One question, then the composer. Everything a new session needs — project,
       task, model — sits on the bar directly below, so this stays a headline. -->
  <div
    class="flex h-full min-h-0 w-full flex-col items-center justify-center gap-5 px-6 py-3"
  >
    <h1
      class="max-w-[40rem] text-center text-pretty text-[clamp(1.375rem,1rem+1.6vw,1.875rem)] font-semibold leading-[1.25] tracking-[-0.02em] text-(--solus-text-primary)"
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
      <div class="flex items-center gap-1.5 px-3.5 pb-2">
        <ProjectChip
          run={draft.run}
          projectDir={projectRoot}
          label={projectName}
          onSelect={selectProject}
          onBrowse={browseProjects}
          onDismiss={focusComposer}
        />
        <TaskPicker
          task={draft.task}
          projectKey={projectRoot}
          onSelect={selectTask}
          onDismiss={focusComposer}
        />
      </div>

      <div
        class={cn(
          "overflow-hidden rounded-2xl bg-(--solus-input-pill-bg) px-3 pb-3",
          "shadow-[shadow:0_0_0_0.03125rem_var(--solus-container-border)]",
        )}
      >
        <InputBar mode="editor" prompt={draft.prompt} onDispatch={dispatch}>
          {#snippet leadingActions(savedPromptsControl)}
            <InputToolbar
              mode="editor"
              onAttachFile={attachFile}
              {onScreenshot}
              {onDesignMode}
              {savedPromptsControl}
            />
          {/snippet}
        </InputBar>
      </div>
    </div>
  </div>
{/if}
