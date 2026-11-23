import { Linking } from "react-native";
import { EmptyState } from "../../../components/ui/EmptyState";
import { FilePreviewLoading } from "../../files/FilePreviewFeedback";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { useSessionController } from "../../../solus/use-session-controller";
import { useCheckoutGit } from "../../../solus/CheckoutGit";
import * as Dialog from "../../../components/ui/Dialog";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  CommonActions,
  StackActions,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { use, useEffect } from "react";
import { RefreshControl } from "../../../components/ui/RefreshControl";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBar } from "../../../components/ui/AppBar";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { groupedListInsets } from "../../../components/ui/listMetrics";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetPane } from "../../../components/ui/SheetPane";
import { InspectorSheetContext } from "../../layout/workspace-inspector-sheet";
import { AppText as Text } from "../../../components/ui/AppText";
import { type GitRepositoryRouteParams } from "../../../state/thread-git-target";
import { menuItemIconName, statusSummary } from "./gitSheetComponents";

type GitOverviewSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
    readonly draftKey?: string;
  } & GitRepositoryRouteParams
> & {
  readonly presentation?: "sheet" | "inspector";
};

export function GitOverviewSheet(props: GitOverviewSheetProps) {
  const navigation = useNavigation();
  const { environmentId, threadId } = props.route.params;
  const gt = useGT();
  const controller = useSessionController(props.route.params);
  const isBlankLink = environmentId.trim().length === 0 || threadId.trim().length === 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator when the route link names a blank environment or thread
  useEffect(() => {
    if (isBlankLink) navigation.goBack();
  }, [isBlankLink, navigation]);
  if (isBlankLink) return null;
  return controller ? (
    <GitOverviewSheetContent {...props} controller={controller} />
  ) : (
    <EmptyState
      title={gt("Session unavailable")}
      detail={gt("Open the session to view source control.")}
    />
  );
}

function GitOverviewSheetContent(
  props: GitOverviewSheetProps & { controller: ConversationController },
) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentation = props.presentation ?? "sheet";
  const isInspector = presentation === "inspector";
  const closeInspectorSheet = use(InspectorSheetContext);
  const presentRoute = (present: () => void) =>
    closeInspectorSheet ? closeInspectorSheet(present) : present();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { controller } = props;
  const git = useCheckoutGit(controller, controller.run.workingDirectory);
  const currentBranchLabel = git.status?.refName ?? gt("Detached HEAD");
  const currentStatusSummary = statusSummary(git.status, m);
  const currentWorktreePath = controller.checkoutWorktree;
  const busy = git.busy,
    canWriteSourceControl = git.canWrite,
    canChangeThreadBranch = git.canWrite && controller.canChooseStart;
  const isRepo = !!git.status?.isRepo,
    hasPrimaryRemote = !!git.status?.hasPrimaryRemote;
  const menuItems = isRepo ? buildMenuItems(git.status, busy, hasPrimaryRemote, m) : [];
  const sheetMenuItems = menuItems.map((item) => ({
    item: {
      ...item,
      disabled: item.disabled || (!canWriteSourceControl && item.kind !== "open_pr"),
    },
    disabledReason:
      !canWriteSourceControl && item.kind !== "open_pr"
        ? gt("This connection cannot change source control.")
        : getGitActionDisabledReason(
            {
              item,
              gitStatus: git.status,
              isBusy: busy,
              hasOriginRemote: hasPrimaryRemote,
            },
            m,
          ),
  }));

  const term = "pr";
  const openExistingPr = () =>
    git.status?.pr &&
    Linking.openURL(git.status.pr.url).catch((error) =>
      Dialog.alert(gt("Could not open pull request"), String(error)),
    );
  const runActionWithPrompt = (input: GitActionRequestInput) => {
    if (
      git.status?.refName &&
      requiresDefaultBranchConfirmation(input.action, git.status.isDefaultRef)
    )
      git.confirm(input, git.status.refName);
    else return git.perform(input);
  };
  const onPressMenuItem = async (item: (typeof menuItems)[number]) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (!canWriteSourceControl) return;
    if (item.dialogAction === "commit") {
      presentRoute(() =>
        navigation.navigate("GitCommit", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
      return;
    }
    if (item.dialogAction === "push") {
      await runActionWithPrompt({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      await runActionWithPrompt({ action: "create_pr" });
    }
  };

  const rowStatusDetail = (item: (typeof menuItems)[number]): string | undefined => {
    const status = git.status;
    if (status == null) {
      return undefined;
    }
    if (item.dialogAction === "commit" && status.hasWorkingTreeChanges) {
      const fileCount = status.workingTree?.files.length ?? 0;
      return gt("{count, plural, one {{count} file changed} other {{count} files changed}}", {
        count: fileCount,
      });
    }
    if (item.dialogAction === "push" && (status.aheadCount ?? 0) > 0) {
      const ahead = status.aheadCount ?? 0;
      return gt("{count, plural, one {{count} commit ahead} other {{count} commits ahead}}", {
        count: ahead,
      });
    }
    if (item.kind === "open_pr" && status.pr?.number != null) {
      return gt(
        "{term, select, mr {MR #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}} cr {change request #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}} other {PR #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}}}",
        {
          term,
          number: status.pr.number,
          state: status.pr.state ?? "open",
        },
      );
    }
    return undefined;
  };

  const behindCount = git.status?.behindCount ?? 0;

  const isRefreshing = git.refreshing;
  const handleRefresh = git.refresh;
  const content = (
    <NativeScrollView
      nestedScrollEnabled
      alwaysBounceVertical
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        ...groupedListInsets(isInspector),
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 18) + 18,
      }}
      refreshControl={
        <RefreshControl refreshing={isRefreshing} onRefresh={() => void handleRefresh()} />
      }
    >
      {git.error ? (
        <EmptyState
          title={gt("Git unavailable")}
          detail={git.error}
          actionLabel={gt("Retry")}
          onAction={git.refresh}
        />
      ) : !git.status ? (
        <FilePreviewLoading message={gt("Loading repository status…")} />
      ) : null}
      {sheetMenuItems.length > 0 || behindCount > 0 ? (
        <ListSection>
          {sheetMenuItems.map(({ item, disabledReason }) => (
            <ListRow
              key={`${item.id}-${item.label}`}
              icon={menuItemIconName(item.icon)}
              label={item.label}
              description={disabledReason ?? rowStatusDetail(item)}
              disabled={item.disabled}
              onPress={() => void onPressMenuItem(item)}
            />
          ))}
          {behindCount > 0 ? (
            <ListRow
              icon="arrow.down.circle"
              label={gt("Pull latest")}
              description={
                canWriteSourceControl
                  ? gt(
                      "{count, plural, one {{count} commit behind upstream} other {{count} commits behind upstream}}",
                      { count: behindCount },
                    )
                  : gt("This connection cannot change source control.")
              }
              disabled={!canWriteSourceControl || busy || !isRepo}
              onPress={() => void git.pull()}
            />
          ) : null}
        </ListSection>
      ) : null}

      <ListSection>
        <ListRow
          icon="text.bubble"
          label={gt("Review changes")}
          description={gt("Inspect changes, uncommitted edits, and turn diffs")}
          disabled={busy || !isRepo}
          onPress={() => {
            const params = { environmentId, threadId, draftKey: props.route.params.draftKey };
            if (presentation === "sheet") {
              navigation.dispatch(StackActions.replace("ThreadReview", params));
            } else {
              presentRoute(() =>
                navigation.dispatch(CommonActions.navigate("ThreadReview", params)),
              );
            }
          }}
        />
        {controller.canChooseStart ? (
          <ListRow
            icon="arrow.branch"
            label={gt("Choose branch")}
            disabled={!git.canWrite || busy || !isRepo}
            onPress={() =>
              presentRoute(() => navigation.navigate("NewTaskBranch", { environmentId, threadId }))
            }
          />
        ) : null}
        <ListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          label={gt("Branches & worktrees")}
          description={
            canChangeThreadBranch
              ? gt("Switch branch, create branch, or move to a worktree")
              : gt("View branches and worktrees")
          }
          disabled={busy || !isRepo}
          onPress={() =>
            presentRoute(() =>
              navigation.navigate("GitBranches", {
                environmentId: String(environmentId),
                threadId: String(threadId),
              }),
            )
          }
        />
      </ListSection>
      {currentWorktreePath ? (
        <ListSection title={gt("Worktree")}>
          <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
            {currentWorktreePath}
          </Text>
        </ListSection>
      ) : null}
    </NativeScrollView>
  );

  const refresh = {
    accessibilityLabel: gt("Refresh repository status"),
    disabled: busy || isRefreshing,
    onPress: () => void handleRefresh(),
  };

  return (
    <SheetPane surface={isInspector ? "screen" : "sheet"}>
      <AppBar
        title={currentBranchLabel}
        subtitle={currentStatusSummary}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
        refresh={refresh}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </SheetPane>
  );
}
