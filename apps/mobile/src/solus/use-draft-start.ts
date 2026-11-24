import { useEffect, useSyncExternalStore } from "react";
import { useListened } from "@solus-mobile/app/app-context";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { EnvironmentId } from "@t3tools/contracts";
import { useMessages } from "gt-react-native";

import { useWorktreeRepositoryChoices } from "../state/use-worktree-repository-choices";
import { readProjectCodebases } from "./codebase-folders";
import { solus } from "./runtime";
import { draftCodebase, resolveWorktreeRepositories } from "./session-repositories";

/**
 * What a new session of a project starts with (docs/plans/codebases.md §7):
 * its codebase, and the repositories that get a worktree with a new worktree.
 * The codebases model owns each read. This hook applies the rule for the
 * folder of the draft and gives the answer to the draft controls and to the
 * repositories checklist.
 */
export function useDraftStart(store: ConversationStore) {
  const { controller } = store;
  const messages = useMessages();
  const meta = useSyncExternalStore(store.meta.subscribe, store.metaSnapshotOf);
  const hostId = controller.hostId;
  const canChoose = meta.runOptions.canChooseStart;
  const projectDirectory = meta.run.projectDirectory;
  // The model reads the codebases of each host only while a screen asks for them.
  useEffect(() => (canChoose ? solus.codebases.watch() : undefined), [canChoose]);
  const { sections } = useListened(solus.codebases.changes, () =>
    readProjectCodebases(hostId, projectDirectory),
  );
  const codebase = draftCodebase({
    codebases: sections.map((section) => section.codebase),
    isPicked: meta.run.isCodebasePicked,
    codebaseId: meta.run.codebaseId,
  });
  const { automatic } = codebase;
  // The folder of the project gives the codebase until the person chooses one: the run must name it before the first prompt.
  useEffect(() => {
    if (canChoose) controller.followFolderCodebase(automatic);
  }, [automatic, canChoose, controller]);
  // A folder in no codebase can hold repositories. The host then makes a codebase at the first prompt
  // (decision 13), so the folder is read here, and its repositories are the list of a new worktree.
  const formsNew = canChoose && sections.length === 0 && !meta.run.isCodebasePicked;
  useEffect(() => {
    if (formsNew && projectDirectory) void solus.codebases.readFolder(hostId, projectDirectory);
  }, [formsNew, hostId, projectDirectory]);
  const foundMembers = useListened(solus.codebases.changes, () =>
    formsNew ? (solus.codebases.newCodebaseAt(hostId, projectDirectory)?.members ?? null) : null,
  );
  const choices = useWorktreeRepositoryChoices(
    canChoose && (codebase.codebaseId !== null || foundMembers !== null)
      ? {
          environmentId: EnvironmentId.make(hostId),
          workspaceRoot: projectDirectory,
          codebaseId: codebase.codebaseId,
          foundMembers,
        }
      : null,
  );
  const selection = resolveWorktreeRepositories(
    { repositories: choices.repositories, chosen: meta.run.worktreeRepositories },
    messages,
  );
  return { meta, codebase, choices, selection };
}
