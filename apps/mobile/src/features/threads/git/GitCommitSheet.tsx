import { useSessionController } from "../../../solus/use-session-controller";
import { useCheckoutCommit, useCheckoutGitTarget } from "../../../solus/CheckoutGit";
import type { ConversationController } from "@solus-mobile/features/conversation/conversation-controller";
import { FilePreviewLoading } from "../../files/FilePreviewFeedback";
import { EmptyState } from "../../../components/ui/EmptyState";
import type { GitActionRequestInput } from "@t3tools/client-runtime/state/vcs";
import type { VcsStatusResult } from "@t3tools/contracts";
import { FitSheet } from "../../../components/ui/FitSheet";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { Button } from "../../../components/ui/Button";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { T, useGT, Var } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import { useHostQueryScope } from "../../../state/host-query-scope";
import { type GitRepositoryRouteParams } from "../../../state/thread-git-target";

type GitCommitSheetProps = StaticScreenProps<
  {
    readonly environmentId: string;
    readonly threadId: string;
  } & GitRepositoryRouteParams
>;

// The sheet closes on submit. Retain the file choice for a retry in the same checkout.
const retainedExclusions = new Map<
  string,
  { readonly branch: string | null; readonly excluded: ReadonlySet<string> }
>();

export function GitCommitSheet(props: GitCommitSheetProps) {
  const controller = useSessionController(props.route.params);
  return controller ? (
    <Commit
      key={JSON.stringify(props.route.params)}
      controller={controller}
      params={props.route.params}
    />
  ) : (
    <EmptyState title="Session unavailable" detail="Open the session to commit changes." />
  );
}
function Commit({
  controller,
  params,
}: {
  controller: ConversationController;
  params: GitCommitSheetProps["route"]["params"];
}) {
  // The commit of the thread's own folder, or of the repository that the route names.
  const target = useCheckoutGitTarget(controller, params);
  const { git, files } = useCheckoutCommit(controller, target);
  const scope = useHostQueryScope(controller.hostId);
  const selectionKey = JSON.stringify([scope, controller.hostId, target.cwd]);
  const error = files.error ?? git.error;
  if (error)
    return (
      <EmptyState
        title="Git unavailable"
        detail={error}
        actionLabel="Retry"
        onAction={() => {
          files.refresh();
          git.refresh();
        }}
      />
    );
  if (!files.data || !git.status) return <FilePreviewLoading message="Loading changed files…" />;
  return (
    <GitCommitForm
      key={selectionKey}
      selectionKey={selectionKey}
      allFiles={files.data}
      branch={git.status.refName}
      busy={git.busy}
      canWriteSourceControl={git.canWrite}
      canCreateFeatureBranch={git.canWrite && controller.canChooseStart}
      isDefaultRef={git.status.isDefaultRef}
      repositoryName={target.repository?.name}
      onCommit={(input) =>
        git.perform(
          {
            ...input,
            filePaths: input.filePaths ?? files.data?.map((file) => file.path),
          },
          git.status?.refName ?? undefined,
        )
      }
    />
  );
}

export function GitCommitForm({
  allFiles,
  isDefaultRef,
  busy,
  canWriteSourceControl,
  canCreateFeatureBranch,
  branch = null,
  selectionKey,
  repositoryName,
  onCommit,
}: {
  allFiles: VcsStatusResult["workingTree"]["files"];
  isDefaultRef: boolean;
  busy: boolean;
  canWriteSourceControl: boolean;
  canCreateFeatureBranch: boolean;
  branch?: string | null;
  selectionKey: string;
  repositoryName?: string;
  onCommit: (input: GitActionRequestInput) => Promise<boolean>;
}) {
  const gt = useGT();
  const navigation = useNavigation();
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const retained = retainedExclusions.get(selectionKey);
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(
    retained?.branch === branch ? retained.excluded : new Set(),
  );
  const [selectionBranch, setSelectionBranch] = useState(branch);
  if (selectionBranch !== branch) {
    setSelectionBranch(branch);
    setExcludedFiles(new Set());
  }

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;
  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);

  const runCommitAction = async (featureBranch: boolean) => {
    if (!canWriteSourceControl || (featureBranch && !canCreateFeatureBranch)) return;
    const commitMessage = dialogCommitMessage.trim();
    retainedExclusions.set(selectionKey, { branch, excluded: excludedFiles });
    navigation.goBack();
    const committed = await onCommit({
      action: "commit",
      featureBranch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
    });
    if (committed && retainedExclusions.get(selectionKey)?.excluded === excludedFiles) {
      retainedExclusions.delete(selectionKey);
    }
  };

  return (
    <FitSheet
      header={
        <SheetHeader
          title={gt("Commit changes")}
          subtitle={[repositoryName, branch ?? gt("(detached HEAD)")].filter(Boolean).join(" · ")}
          onCancel={() => navigation.goBack()}
          accessibilityLabel={gt("Cancel commit")}
        />
      }
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      contentContainerClassName="px-5 pt-4 gap-5"
    >
      {isDefaultRef ? (
        <Text className="text-sm text-warning-foreground">
          <T>You’re on the default branch. You can create a new branch when committing.</T>
        </Text>
      ) : null}
      <View className="gap-2">
        <Text className="text-sm font-t3-medium text-foreground">
          <T>Commit message</T>
        </Text>
        <TextInput
          multiline
          accessibilityLabel={gt("Commit message")}
          value={dialogCommitMessage}
          onChangeText={setDialogCommitMessage}
          placeholder={gt("Describe your changes…")}
          textAlignVertical="top"
          className="min-h-24 rounded-xl bg-subtle px-4 py-3 text-base"
        />
        <Text className="text-xs text-foreground-muted">
          <T>Leave empty to generate a message automatically.</T>
        </Text>
      </View>
      <View>
        <View className="flex-row items-center justify-between gap-2 pb-2">
          <View className="flex-1 gap-1">
            <Text className="text-base font-t3-bold text-foreground">
              <T>Changed files</T>
            </Text>
            <Text className="text-xs text-foreground-muted">
              <T>
                <Var>{selectedFiles.length}</Var> of <Var>{allFiles.length}</Var> selected · +
                <Var>{formatDiffCount(selectedInsertions)}</Var> −
                <Var>{formatDiffCount(selectedDeletions)}</Var>
              </T>
            </Text>
          </View>
          {allFiles.length > 0 ? (
            <Button
              label={
                allSelected
                  ? gt("Deselect all")
                  : gt("Select all", { $context: "selects every changed file to commit" })
              }
              tone="text"
              onPress={() =>
                setExcludedFiles(
                  allSelected ? new Set(allFiles.map((file) => file.path)) : new Set(),
                )
              }
            />
          ) : null}
        </View>
        {allFiles.length === 0 ? (
          <Text className="py-4 text-sm text-foreground-muted">
            <T>No changed files to commit.</T>
          </Text>
        ) : (
          allFiles.map((file) => {
            const included = !excludedFiles.has(file.path);
            const slash = file.path.lastIndexOf("/");
            const name = file.path.slice(slash + 1);
            const directory = slash >= 0 ? file.path.slice(0, slash) : null;
            return (
              <Pressable
                key={file.path}
                className="min-h-16 flex-row items-center gap-3 border-t border-border-subtle py-3"
                accessibilityRole="checkbox"
                accessibilityLabel={file.path}
                accessibilityState={{ checked: included }}
                onPress={() =>
                  setExcludedFiles((current) => {
                    const next = new Set(current);
                    if (next.has(file.path)) next.delete(file.path);
                    else next.add(file.path);
                    return next;
                  })
                }
              >
                <View
                  className={cn(
                    "size-5 items-center justify-center rounded-full",
                    included ? "bg-primary" : "border border-input-border",
                  )}
                >
                  {included ? (
                    <SymbolView
                      name="checkmark"
                      size={13}
                      tintColorClassName="accent-primary-foreground"
                    />
                  ) : null}
                </View>
                <View className="flex-1 gap-1">
                  <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    className="text-sm font-t3-medium text-foreground"
                  >
                    {name}
                  </Text>
                  {directory ? (
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="middle"
                      className="text-xs text-foreground-muted"
                    >
                      {directory}
                    </Text>
                  ) : null}
                </View>
                <View className="flex-row gap-2">
                  <Text className="text-xs text-adaptive-emerald-700-300">
                    +{formatDiffCount(file.insertions)}
                  </Text>
                  <Text className="text-xs text-adaptive-rose-700-300">
                    −{formatDiffCount(file.deletions)}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </View>
      <View className="gap-2">
        <Button
          label={gt("Commit changes")}
          icon="checkmark"
          tone="primary"
          fullWidth
          disabled={!canWriteSourceControl || noneSelected || busy}
          onPress={() => void runCommitAction(false)}
        />
        <Button
          label={gt("Commit on a new branch")}
          icon="arrow.branch"
          tone="text"
          fullWidth
          disabled={!canWriteSourceControl || !canCreateFeatureBranch || noneSelected || busy}
          onPress={() => void runCommitAction(true)}
        />
      </View>
    </FitSheet>
  );
}
