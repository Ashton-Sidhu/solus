import { useCallback, useMemo } from "react";
import { useGT } from "gt-react-native";
import type { HostApi } from "@solus/client-core/host-api";
import { hostPathBaseName } from "@solus/contracts/host-path";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { useHostSettingsRead } from "./use-host-settings-read";
import { useSessionFolders } from "./use-session-controller";
import {
  combinedReviewPatch,
  joinTurnsByTrace,
  REVIEW_ROOT_REPOSITORY,
  reviewDiffReads,
  reviewRepositories,
  type ReviewSectionScope,
} from "./session-repositories";
import {
  getReviewSectionIdForCheckpoint,
  resolveReviewSelectedSectionId,
  type ReviewSectionItem,
} from "../features/review/reviewModel";
import {
  setReviewSelectedSectionId,
  type ReviewCacheForThread,
} from "../features/review/reviewState";

type CheckoutSection = ReviewSectionItem & { scope: ReviewSectionScope };

/**
 * The sections of a session's review, over each repository of the session
 * (docs/plans/codebases.md §8): its own checkout and its `git` session
 * folders. The patch of each repository is read with its `repositoryPath`,
 * and the turns of the repositories join by their trace. A session with one
 * checkout reads that checkout only, as before.
 */
export function useCheckoutReviewSections(
  controller: ConversationController,
  cache: ReviewCacheForThread,
) {
  const gt = useGT();
  const cwd = controller.run.workingDirectory;
  const sessionId = controller.run.sessionId;
  const folders = useSessionFolders({ environmentId: controller.hostId, threadId: sessionId });
  const hasRepositories = folders.some((folder) => folder.state === "git");
  // The change summary names the repositories that the session changed. It is read only for a session with more than one.
  const summary = useHostSettingsRead(
    controller.hostId,
    useCallback(
      async (api: HostApi) =>
        hasRepositories
          ? ((await api.sessionTree(sessionId)).nodes[0]?.digest?.changes ?? null)
          : null,
      [hasRepositories, sessionId],
    ),
  );
  const changes = summary.data ?? null;
  const repositories = useMemo(
    () =>
      reviewRepositories({
        workingDirectory: cwd,
        rootName: hostPathBaseName(cwd) || cwd,
        folders,
        summary: changes,
      }),
    [cwd, folders, changes],
  );
  const snapshots = useHostSettingsRead(
    controller.hostId,
    useCallback(
      async (api: HostApi) => {
        const context = controller.context();
        if (repositories.length === 0) {
          return [{ key: REVIEW_ROOT_REPOSITORY, snapshots: await api.listTurnSnapshots(context) }];
        }
        // A working directory that is not a repository has no snapshots: the session folders still have theirs.
        return Promise.all(
          repositories.map(async (repository) => ({
            key: repository.key,
            snapshots: await api
              .listTurnSnapshots(context, repository.repositoryPath)
              .catch(() => []),
          })),
        );
      },
      [controller, cwd, repositories],
    ),
    "git.checkoutChanged",
  );
  const sections = useMemo((): CheckoutSection[] => {
    const turns = joinTurnsByTrace(snapshots.data ?? []);
    return [
      {
        id: "git:branch-range",
        kind: "branch-range",
        title: gt("Changes", { $context: "diff section: branch changes" }),
        subtitle: null,
        scope: { kind: "branch" },
        diff: null,
        isLoading: false,
      },
      {
        id: "git:working-tree",
        kind: "working-tree",
        title: gt("Uncommitted", { $context: "diff section: working tree" }),
        subtitle: null,
        scope: { kind: "working-tree" },
        diff: null,
        isLoading: false,
      },
      {
        id: "session",
        kind: "session",
        title: gt("Session"),
        subtitle: null,
        scope: { kind: "session" },
        diff: null,
        isLoading: false,
      },
      ...turns.map((turn, position): CheckoutSection => {
        const ownIndex = turn.indexes[REVIEW_ROOT_REPOSITORY];
        return {
          // A turn of the session's own checkout keeps the id that the feed selects it by.
          id:
            ownIndex === undefined
              ? `turn:${turn.id}`
              : getReviewSectionIdForCheckpoint({ checkpointTurnCount: ownIndex + 1 }),
          kind: "turn",
          // Each repository counts its own snapshots, so the number of a turn over several repositories is its place in the joined list.
          title: gt("Turn {count}", {
            count:
              repositories.length === 0 && ownIndex !== undefined
                ? ownIndex + 1
                : turns.length - position,
          }),
          subtitle: turn.userMessagePreview || null,
          scope: { kind: "turn", indexes: turn.indexes },
          diff: null,
          isLoading: false,
        };
      }),
    ];
  }, [gt, repositories.length, snapshots.data]);
  const selectedId = resolveReviewSelectedSectionId(sections, cache.selectedSectionId);
  const selected = sections.find((item) => item.id === selectedId)!;
  const reads = reviewDiffReads(repositories, selected.scope);
  // The reads stay the same across renders, including when another snapshot arrives.
  const readsKey = JSON.stringify(reads);
  const diff = useHostSettingsRead(
    controller.hostId,
    useCallback(
      async (api: HostApi) => {
        const context = controller.context();
        const wanted: typeof reads = JSON.parse(readsKey);
        if (wanted.length === 1) {
          const patch = (await api.diff(context, wanted[0]!.request))?.patch ?? null;
          return patch === null ? null : combinedReviewPatch([{ ...wanted[0]!, patch }]);
        }
        // The session's own context, with the repository that each read names. A repository that gives no patch has no changes.
        const answers = await Promise.all(
          wanted.map(async (read) => ({
            ...read,
            patch: (await api.diff(context, read.request).catch(() => null))?.patch ?? null,
          })),
        );
        return answers.every((answer) => answer.patch === null) && answers.length > 0
          ? null
          : combinedReviewPatch(answers);
      },
      [controller, cwd, readsKey],
    ),
    "git.checkoutChanged",
  );
  const loadedSection: CheckoutSection = {
    ...selected,
    diff: diff.data?.diff ?? null,
    isLoading: !diff.error && diff.data === undefined,
  };
  // T3's repository selector shows only when the section has groups.
  const selectedSection: CheckoutSection = diff.data?.groups
    ? { ...loadedSection, repositoryGroups: diff.data.groups }
    : loadedSection;
  return {
    reviewSections: sections.map((item) => (item.id === selectedId ? selectedSection : item)),
    selectedSection,
    isSelectedSectionPending: selectedSection.isLoading || diff.isRefreshing,
    error: diff.error ?? (diff.data === null ? gt("Diff unavailable") : snapshots.error),
    selectSection: (id: string) => {
      if (cache.threadKey) setReviewSelectedSectionId(cache.threadKey, id);
    },
    refreshSelectedSection: async () => {
      diff.refresh();
      snapshots.refresh();
      summary.refresh();
    },
  };
}
