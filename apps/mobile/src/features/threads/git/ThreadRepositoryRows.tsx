import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import {
  repositorySectionSummary,
  THREAD_REPOSITORY_SECTIONS_VISIBLE,
  type PinnedThreadRepository,
  type RepositorySectionSummary,
} from "@t3tools/client-runtime/state/thread-repositories";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import type { HostApi } from "@solus/client-core/host-api";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { useListened } from "@solus-mobile/app/app-context";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { memo, useCallback, useState } from "react";

import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import type { MessageResolver } from "../../../i18n/messages";
import { useFolderGitStatus } from "../../../solus/CheckoutGit";
import { codebaseFolders } from "../../../solus/codebase-folders";
import { solus } from "../../../solus/runtime";
import {
  addableWorktreeRepositories,
  pinnableRepositories,
  sessionFolderMark,
  sessionFolderMarkText,
  sessionRepositorySections,
  type SessionRepositorySection,
  type SessionRepositorySections,
} from "../../../solus/session-repositories";
import { useHostSettingsRead } from "../../../solus/use-host-settings-read";
import { useSessionFolders } from "../../../solus/use-session-controller";
import { useEnvironmentQuery } from "../../../state/query";
import {
  pinRepositoryToThread,
  useThreadRepositoryPins,
} from "../../../state/thread-repository-pins";

function repositoryRowDescription(
  summary: RepositorySectionSummary | null,
  error: string | null,
  resolve: MessageResolver,
): string {
  if (summary === null) return error ?? resolve(msg("Checking status"));
  if (!summary.isRepository) return resolve(msg("Not a Git repository"));
  const branch = summary.branch ?? resolve(msg("Detached HEAD"));
  if (summary.changedFiles === 0) return resolve(msg("{branch} · Clean", { branch }));
  // The list reads each repository with no line totals: the totals need a scan of its worktree.
  if (summary.insertions === 0 && summary.deletions === 0) {
    return resolve(
      msg("{branch} · {count, plural, one {{count} file} other {{count} files}}", {
        branch,
        count: summary.changedFiles,
      }),
    );
  }
  return resolve(
    msg(
      "{branch} · {count, plural, one {{count} file} other {{count} files}} · +{insertions} −{deletions}",
      {
        branch,
        count: summary.changedFiles,
        insertions: formatDiffCount(summary.insertions),
        deletions: formatDiffCount(summary.deletions),
      },
    ),
  );
}

const RepositoryRow = memo(function RepositoryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly section: SessionRepositorySection;
  readonly onOpen: (section: SessionRepositorySection) => void;
}) {
  // Local status only: the branch and the changed files of the folder's own path, with no scan
  // for line totals and no pull request read. The repository opened for actions reads them.
  const status = useFolderGitStatus(props.environmentId, props.section.cwd, false);
  const summary = repositorySectionSummary(status.data);
  const resolve = useMessages();
  const mark = props.section.folder ? sessionFolderMark(props.section.folder) : null;
  return (
    <ListRow
      icon="folder"
      label={props.section.name}
      description={repositoryRowDescription(summary, status.error ?? null, resolve)}
      detail={
        summary?.isRepository && summary.pullRequest
          ? `#${summary.pullRequest.number}`
          : mark
            ? sessionFolderMarkText(mark, resolve)
            : undefined
      }
      onPress={() => props.onOpen(props.section)}
    />
  );
});

/**
 * Mounted while the picker is open, so the list is read only when someone asks for it. A session
 * in a task folder gets the repositories that its host accepts for one more worktree
 * (`sessionWorktreeCandidates`). Each other session gets the `git` members of its codebase that
 * are not rows yet, to pin.
 */
function OtherRepositoryRows(props: {
  readonly environmentId: EnvironmentId;
  readonly controller: ConversationController;
  readonly sections: SessionRepositorySections;
  readonly onPick: (repository: PinnedThreadRepository) => void;
}) {
  const gt = useGT();
  const { controller } = props;
  const worksInTaskFolder = controller.worksInTaskFolder;
  const codebaseId = controller.run.codebaseId ?? null;
  const candidates = useHostSettingsRead(
    props.environmentId,
    useCallback(
      async (api: HostApi) =>
        worksInTaskFolder ? api.sessionWorktreeCandidates(controller.run.sessionId) : null,
      [controller, worksInTaskFolder],
    ),
  );
  const members = useEnvironmentQuery(
    !worksInTaskFolder && codebaseId !== null
      ? codebaseFolders.members({ environmentId: props.environmentId, input: { codebaseId } })
      : null,
  );
  const repositories = worksInTaskFolder
    ? candidates.data == null
      ? null
      : addableWorktreeRepositories(candidates.data)
    : members.data === null
      ? null
      : pinnableRepositories({
          members: members.data,
          sections: props.sections,
          threadCwd: controller.run.workingDirectory,
        });
  if (repositories === null) {
    return (
      <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
        {(worksInTaskFolder ? candidates.error : members.error) ?? gt("Loading repositories…")}
      </Text>
    );
  }
  if (repositories.length === 0) {
    return (
      <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
        <T>No other repositories</T>
      </Text>
    );
  }
  return repositories.map((repository) => (
    <ListRow
      key={repository.repositoryPath}
      icon="plus"
      label={repository.name}
      onPress={() => props.onPick(repository)}
    />
  ));
}

/**
 * "Other repositories…" and the list it opens. In a task folder, a pick makes the session's
 * worktree of the repository. In each other session, a pick is T3's pin: the repository shows in
 * this thread until the app closes.
 */
function OtherRepositoriesPicker(props: {
  readonly threadRef: ScopedThreadRef;
  readonly controller: ConversationController;
  readonly sections: SessionRepositorySections;
  readonly pinnedCount: number;
  readonly onShowAll: () => void;
}) {
  const { threadRef, controller } = props;
  const gt = useGT();
  const [isOpen, setIsOpen] = useState(false);
  const [addingName, setAddingName] = useState<string | null>(null);
  const worksInTaskFolder = controller.worksInTaskFolder;
  // A promise chain, not `try` with `finally`: the React Compiler does not compile that statement.
  const addWorktree = (repository: PinnedThreadRepository) => {
    if (addingName !== null) return Promise.resolve();
    setAddingName(repository.name);
    setIsOpen(false);
    return controller
      .addRepositoryWorktree(repository.repositoryPath)
      .then(props.onShowAll, (error) =>
        Dialog.alert(
          gt("Could not add {name}", { name: repository.name }),
          error instanceof Error ? error.message : String(error),
        ),
      )
      .then(() => setAddingName(null));
  };
  const pin = (repository: PinnedThreadRepository) => {
    pinRepositoryToThread(threadRef, repository);
    // Pins beyond the visible few would land folded away, out of sight.
    if (props.pinnedCount >= THREAD_REPOSITORY_SECTIONS_VISIBLE) props.onShowAll();
    setIsOpen(false);
  };
  const hint = worksInTaskFolder ? gt("Add a worktree") : gt("Show in this thread");
  return (
    <>
      <ListRow
        icon="folder.badge.plus"
        label={
          addingName === null
            ? gt("Other repositories…")
            : gt("Adding a worktree of {name}…", { name: addingName })
        }
        description={isOpen || addingName !== null ? undefined : hint}
        disabled={addingName !== null}
        onPress={() => setIsOpen((current) => !current)}
      />
      {isOpen ? (
        <OtherRepositoryRows
          environmentId={threadRef.environmentId}
          controller={controller}
          sections={props.sections}
          onPick={(repository) =>
            worksInTaskFolder ? void addWorktree(repository) : pin(repository)
          }
        />
      ) : null}
    </>
  );
}

/**
 * The repositories of a session besides its working directory: its session folders
 * (docs/plans/codebases.md §6), each with the branch and the changes of its own path, and the
 * repositories that the person pinned. In a task folder, each row is the session's own worktree,
 * and adding one makes that worktree. Folded rows are not rendered, so they read nothing.
 */
export function ThreadRepositoryRows(props: {
  readonly threadRef: ScopedThreadRef;
  readonly controller: ConversationController;
  readonly onOpen: (section: SessionRepositorySection) => void;
}) {
  const { threadRef, controller } = props;
  const gt = useGT();
  const folders = useSessionFolders(threadRef);
  const pinned = useThreadRepositoryPins(threadRef);
  const canReadFiles = useListened(solus.connections.changes, () =>
    solus.connections.may(threadRef.environmentId, "host.files.read"),
  );
  const [showAll, setShowAll] = useState(false);
  const worksInTaskFolder = controller.worksInTaskFolder;
  // A session reaches more repositories only through its task folder or its codebase.
  const reachesMore = worksInTaskFolder || (controller.run.codebaseId ?? null) !== null;

  const sections = sessionRepositorySections({
    folders,
    pinned,
    threadCwd: controller.run.workingDirectory,
    showAll,
    worksInTaskFolder,
  });
  const offersPicker = reachesMore && canReadFiles && (!worksInTaskFolder || controller.mayDrive);
  if (sections.visible.length === 0 && !offersPicker) return null;
  const foldable =
    sections.hidden.length > 0 ||
    (showAll && sections.visible.length > THREAD_REPOSITORY_SECTIONS_VISIBLE);

  return (
    <ListSection title={gt("Repositories")}>
      {sections.visible.length === 0 && worksInTaskFolder ? (
        <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
          {gt("This thread has no repository worktrees yet.")}
        </Text>
      ) : null}
      {sections.visible.map((section) => (
        <RepositoryRow
          key={section.key}
          environmentId={threadRef.environmentId}
          section={section}
          onOpen={props.onOpen}
        />
      ))}
      {foldable ? (
        <ListRow
          icon={showAll ? "chevron.up" : "chevron.down"}
          label={
            showAll ? gt("Show fewer") : gt("Show {count} more", { count: sections.hidden.length })
          }
          onPress={() => setShowAll((current) => !current)}
        />
      ) : null}
      {offersPicker ? (
        <OtherRepositoriesPicker
          threadRef={threadRef}
          controller={controller}
          sections={sections}
          pinnedCount={pinned.length}
          onShowAll={() => setShowAll(true)}
        />
      ) : null}
    </ListSection>
  );
}
