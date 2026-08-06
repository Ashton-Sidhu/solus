<script lang="ts" module>
  import { projectsStore, getWorkspaceContext } from "../../contexts";

  export function invalidateHomeCache(): void {
    projectsStore.invalidateRecentProjects();
  }
</script>

<script lang="ts">
  import { serverConnections } from "@client-core/server-connections";
  import { projectDirLabel } from "../../lib/paths";
  import { homeGitDetails } from "../../lib/git-context";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { useKeybinding } from "../../lib/keybindings/use-keybinding.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { Tab } from "../../../shared/types";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";

  interface Props {
    /** The composer this home belongs to. There is always one: the home is what
     *  a tab that has not started a conversation renders. */
    tab: Tab;
  }
  let { tab }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tab.id));

  // The directory the next session starts in. The project keeps its own name
  // even when that session runs in a worktree of it, so the label reads off the
  // repo root rather than the checkout.
  const currentDir = $derived(
    sess?.run.workingDirectory || session.globalDefaults.workingDirectory || "~",
  );
  const gitHome = $derived(
    homeGitDetails(
      currentDir,
      sess?.run.gitContext,
      session.globalDefaults.gitContext,
    ),
  );
  const projectRoot = $derived(gitHome.projectRoot || currentDir);
  const projectName = $derived(
    projectDirLabel(projectRoot, session.staticInfo?.workspacePath),
  );
  // No project chosen yet — "build in ~?" names nothing, so the question drops
  // its object and the input bar's project chip does the choosing.
  const hasProject = $derived(projectName !== "~");
  // A browser with no host cannot answer the question below, so the home asks a
  // different one. A host only ever arrives by page reload, so this is settled
  // at mount. The client owns the surface that connects one; this is the shared
  // renderer, so it asks for it by event.
  const noHost =
    window.solus.getPlatform() === "web" && !serverConnections.connectionFor();
  const workspacePath = $derived(session.staticInfo?.workspacePath ?? null);
  const canReturnToWorkspace = $derived(
    !!workspacePath &&
      currentDir.replace(/\/+$/, "") !== workspacePath.replace(/\/+$/, ""),
  );
  const isFocusedHome = $derived(
    tab.id === (session.focusedChatTabId ?? session.activeTabId),
  );

  function changeDirectory() {
    window.dispatchEvent(
      new CustomEvent("solus:open-project", { detail: { tabId: tab.id } }),
    );
  }

  function returnToWorkspace() {
    if (!workspacePath || !canReturnToWorkspace) return;
    invalidateHomeCache();
    void session.setBaseDirectory(workspacePath, tab.id).then(
      () => requestInputFocus({ tabId: tab.id }),
      () => {},
    );
  }

  // On an empty home, the worktree action cannot apply. Reuse its historical
  // ⌥W binding to return the launch target to the host workspace instead.
  useKeybinding("global.continue-worktree", returnToWorkspace, {
    enabled: () => isFocusedHome && canReturnToWorkspace,
  });
</script>

<!-- New tab home: one question. Everything else a fresh tab needs — worktree,
     host, project — already lives on the input bar directly below it, so the
     home stays a headline and hands the screen to the prompt. -->
<div
  class="flex h-full w-full flex-col items-center justify-center gap-5 px-6 py-3 [animation:home-fade-in_0.24s_ease-out_both]"
>
  {#if noHost}
    <h1
      class="max-w-[40rem] text-center text-pretty text-[clamp(1.375rem,1rem+1.6vw,1.875rem)] font-semibold leading-[1.25] tracking-[-0.02em] text-(--solus-text-primary)"
    >
      Connect a host to get started
    </h1>
    <button
      type="button"
      class="rounded-lg bg-(--solus-accent) px-3.5 py-2 text-[0.8125rem] font-medium text-(--solus-text-on-accent) transition-transform duration-[var(--duration-quick)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
      onclick={() =>
        window.dispatchEvent(new CustomEvent("solus:open-server-connect"))}
    >
      Connect a host
    </button>
  {:else}
  <h1
    class="max-w-[40rem] text-center text-pretty text-[clamp(1.375rem,1rem+1.6vw,1.875rem)] font-semibold leading-[1.25] tracking-[-0.02em] text-(--solus-text-primary)"
  >
    {#if hasProject}
      What should we build in
      <button
        type="button"
        class="group/dir max-w-full whitespace-nowrap rounded-sm border-none bg-transparent p-0 cursor-pointer [font:inherit] [letter-spacing:inherit] text-(--solus-text-primary) transition-colors duration-150 hover:text-(--solus-accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent)"
        onclick={changeDirectory}
        title={`Change project (${comboHint("global.select-project")})`}
      >
        <!-- No whitespace between the mark and the name: a text node here would
             render as an extra word space inside the underlined phrase. -->
        <ProjectFavicon
          {projectRoot}
          class="mr-[0.22em] size-[0.8em] translate-y-[0.05em]"
        /><span
          class="underline decoration-dotted decoration-[color:var(--solus-text-tertiary)] underline-offset-[0.28em] transition-[text-decoration-color] duration-150 group-hover/dir:decoration-[color:var(--solus-accent)]"
          >{projectName}</span
        >
      </button>?
    {:else}
      What should we build?
    {/if}
  </h1>
  {/if}
</div>
