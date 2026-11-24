<script lang="ts">
  /** The body of the Git card. A session can work in more than one
   *  repository (docs/plans/codebases.md §9): the card then lists them, and
   *  its Git rows work in the chosen one. There is one Git section, aimed at
   *  that repository. With one repository the card is the Git section alone. */
  import { isTaskFolderPath } from "@solus/contracts/codebases";
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import { conversationViewStates } from "../conversation/lib/conversation-view-state.svelte";
  import GitRepositories from "./GitRepositories.svelte";
  import GitSection from "./GitSection.svelte";
  import GitSetupSection from "./GitSetupSection.svelte";
  import {
    chosenGitRepository,
    gitFolderOf,
    gitRepositoryChoice,
    showsRepositoryRows,
    type GitRepositoryRow,
  } from "./lib/git-repositories";
  import { isPanelItemShown } from "./lib/panel-items";

  interface Props {
    /** The tab or draft whose run this card describes: see `ProjectPanel`. */
    sourceId: string;
    /** Hidden mounted tabs and a closed project panel must not poll the host. */
    active: boolean;
    /** The person's hidden panel items. A hidden row unmounts. */
    hiddenItems: readonly string[];
    /** The repositories of the run (`gitCardRepositories`). */
    rows: readonly GitRepositoryRow[];
  }
  let { sourceId, active, hiddenItems, rows }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  const panelSession = $derived(session.sessionFor(sourceId));
  const isStarted = $derived(!!panelSession && hasSessionStarted(panelSession));
  const env = $derived(environmentStore.environmentFor(session.runFor(sourceId)));
  const showsRows = $derived(showsRepositoryRows(rows));
  const gitSetupShown = $derived(isPanelItemShown(hiddenItems, "git.setup"));

  // The choice survives a tab switch: it is in the view state of the conversation.
  // A draft has no session folder for the Git rows to work in, so it has no choice.
  const view = $derived(isStarted ? conversationViewStates(session).forTab(sourceId) : null);
  const chosen = $derived(view && showsRows ? chosenGitRepository(rows, view.gitRepositoryPath) : null);
  const folder = $derived(gitFolderOf(chosen));
  // The Git section shows for the repository of the working directory, or for the chosen session folder.
  const hasGitSection = $derived(!!env.checkout || !!folder);
  const canAddRepository = $derived(
    isStarted && isTaskFolderPath(env.cwd) && !!panelSession && canDriveSession(session.serverIdFor(sourceId), panelSession.id),
  );

  function choose(row: GitRepositoryRow) {
    if (view) view.gitRepositoryPath = gitRepositoryChoice(rows, row);
    // The repositories of a draft show what the session gets: a row opens its files.
    else session.openFiles(sourceId, row.path);
    requestInputFocus({ tabId: sourceId });
  }
</script>

{#if showsRows || canAddRepository}
  <GitRepositories {sourceId} {active} {rows} chosenKey={chosen?.key ?? null} {canAddRepository} onChoose={choose} />
{/if}
{#if hasGitSection}
  <!-- One Git section. A choice of a different repository starts it again, so
       no open menu, armed discard, or composer of the last one stays. -->
  {#key folder?.path ?? ""}
    <GitSection
      {sourceId}
      {active}
      {hiddenItems}
      {folder}
      onOpenChanges={showsRows ? () => session.showRepositoryDiff(sourceId, folder?.path ?? null) : undefined}
    />
    {#if gitSetupShown}
      <GitSetupSection {sourceId} {active} {folder} />
    {/if}
  {/key}
{:else if gitSetupShown && !showsRows}
  <!-- No repository yet: this card is only the way in. -->
  <GitSetupSection {sourceId} {active} />
{/if}
