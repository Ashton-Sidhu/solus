import { useCallback, useMemo } from "react";
import { useGT } from "gt-react-native";
import type { HostApi } from "@solus/client-core/host-api";
import type { DiffScope } from "@solus/contracts/git-types";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { useHostSettingsRead } from "./use-host-settings-read";
import {
  getReviewSectionIdForCheckpoint,
  resolveReviewSelectedSectionId,
  type ReviewSectionItem,
} from "../features/review/reviewModel";
import {
  setReviewSelectedSectionId,
  type ReviewCacheForThread,
} from "../features/review/reviewState";

type CheckoutSection = ReviewSectionItem & { scope: Exclude<DiffScope, { kind: "pr" }> };

export function useCheckoutReviewSections(
  controller: ConversationController,
  cache: ReviewCacheForThread,
) {
  const gt = useGT();
  const cwd = controller.run.workingDirectory;
  const snapshots = useHostSettingsRead(
    controller.hostId,
    useCallback((api: HostApi) => api.listTurnSnapshots(controller.context()), [controller, cwd]),
    "git.checkoutChanged",
  );
  const sections = useMemo(
    (): CheckoutSection[] => [
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
      ...(snapshots.data ?? [])
        .toSorted((a, b) => b.index - a.index)
        .map(
          (turn): CheckoutSection => ({
            id: getReviewSectionIdForCheckpoint({ checkpointTurnCount: turn.index + 1 }),
            kind: "turn",
            title: gt("Turn {count}", { count: turn.index + 1 }),
            subtitle: turn.userMessagePreview || null,
            scope: { kind: "turn", index: turn.index },
            diff: null,
            isLoading: false,
          }),
        ),
    ],
    [gt, snapshots.data],
  );
  const selectedId = resolveReviewSelectedSectionId(sections, cache.selectedSectionId);
  const selected = sections.find((item) => item.id === selectedId)!;
  // The scope stays stable across renders, including when another snapshot arrives.
  const selection = selected.scope.kind === "turn" ? selected.scope.index : selected.scope.kind;
  const diff = useHostSettingsRead(
    controller.hostId,
    useCallback(
      (api: HostApi) =>
        api.diff(controller.context(), {
          scope: typeof selection === "number" ? { kind: "turn", index: selection } : { kind: selection },
        }),
      [controller, cwd, selection],
    ),
    "git.checkoutChanged",
  );
  const selectedSection = {
    ...selected,
    diff: diff.data?.patch ?? null,
    isLoading: !diff.error && diff.data === undefined,
  };
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
    },
  };
}
