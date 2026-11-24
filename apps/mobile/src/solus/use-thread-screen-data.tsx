import { hostQueueMessage, hostQueuedRuns, hostQueueAttachments } from "./queue-messages";
import { backgroundTasks } from "./session-work";
import { sessionPromptText } from "./review-prompt";
import { finishDraftSubmission } from "../features/threads/finish-draft-submission";
import type { ThreadDetailScreenProps } from "../features/threads/ThreadDetailScreen";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../state/preferences";
import type { ComposerEditorHandle } from "../components/ComposerEditor";
import {
  useQueuedRunEdit,
  beginQueuedRunEdit,
  endQueuedRunEdit,
  queuedEditDraftKey,
  startQueuedRunEditSave,
} from "../state/queued-run-edit";
import type { QueueAttachment } from "@solus/contracts/session-queue";
import { isChat } from "@solus/contracts/chat";
import { useRememberThreadProject } from "../features/threads/useRememberThreadProject";
import { removeQueuedRunEditAttachment } from "../state/queued-run-edit";
import { videoMimeType } from "@solus/contracts/media-types";
import type { DraftComposerAttachment } from "../lib/composerImages";
import { composerUploadMedia } from "./upload-images";
import {
  pendingInputAnswers,
  pendingInputQuestions,
  toggleQuestionOption,
  typeQuestionRemark,
} from "./pending-question";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { connectionTone } from "../features/connection/connectionTone";
import {
  hasOwnCard,
  permissionForFeedback,
} from "@solus-mobile/features/conversation/lib/pending-requests";
import {
  pickComposerMedia,
  pickComposerFiles,
  pastedComposerImages,
} from "@solus-mobile/features/threads/composer-attachment-pickers";
import { modelLabel } from "@solus-mobile/features/conversation/lib/run-settings";
import { RequestCards, RequestPanels } from "./RequestCards";
import {
  ConversationMedia,
  conversationImageSource,
  resolveConversationImage,
} from "./ConversationMedia";
import { ThreadMcpApp } from "@solus-mobile/features/threads/ThreadMcpApp";
import { ConversationCard } from "./ConversationCard";
import { scopedThreadKey } from "../lib/scopedEntities";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { EnvironmentId, MessageId, RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { isSessionBusyStatus } from "@solus/contracts/types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { conversationFeed } from "./conversation-feed";
import {
  clearComposerDraftContent,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  setComposerDraftText,
  setComposerDraftContext,
} from "../state/use-composer-drafts";
import { useListened } from "@solus-mobile/app/app-context";
import { solus, useSolusWorkspace } from "./runtime";
import { toThreadShell } from "./session";
const wip = () => Alert.alert("WIP");
function useFeed(store: ConversationStore, id: string) {
  const order = useSyncExternalStore(store.order.subscribe, store.orderSnapshot);
  const projectFeed = useMemo(() => {
    return conversationFeed(
      store,
      id,
      (key, superseded, liveAppOnly) =>
        liveAppOnly ? (
          <ThreadMcpApp store={store} id={key} />
        ) : (
          <ConversationCard key={key} store={store} id={key} superseded={superseded} />
        ),
      (path, refresh) => resolveConversationImage(store, path, refresh).then((image) => image.uri),
      (key) => store.controller.readToolInput(key),
    );
  }, [store, id]);
  const reader = useMemo(() => projectFeed(order), [projectFeed, order]);
  return useSyncExternalStore(reader.subscribe, reader.get);
}

export function useThreadScreenData({
  draftKey,
  isDraft,
  store,
  hostId,
  id,
}: {
  store: ConversationStore;
  draftKey?: string;
  isDraft: boolean;
  hostId: string;
  id: string;
}) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const showToolCalls = useSyncExternalStore(
    solus.personal.changes.subscribe,
    () => solus.personal.current().showToolCalls,
  );
  const controller = store.controller;
  const meta = useSyncExternalStore(store.meta.subscribe, store.metaSnapshotOf);
  const queuedMessages = useMemo(
    () =>
      meta.queue.entries
        .filter((entry) => entry.kind !== "provider_switch")
        .map((entry) =>
          hostQueueMessage(EnvironmentId.make(hostId), ThreadId.make(id), entry, (path, refresh) =>
            resolveConversationImage(store, path, refresh).then((image) => image.uri),
          ),
        ),
    [meta.queue.entries, hostId, id, store],
  );
  const feed = useFeed(store, id);
  const directory = useSolusWorkspace();
  const navigation = useNavigation();
  const [openedAt] = useState(Date.now);
  const listed = useSyncExternalStore(
    solus.threads.changes.subscribe,
    () => solus.threads.thread(hostId, id)?.record,
  );
  const busy = isSessionBusyStatus(meta.status);
  const shell = toThreadShell(
    hostId,
    {
      ...(listed ?? {
        sessionId: id,
        provider: meta.run.provider,
        projectPath: meta.run.workingDirectory,
        title: meta.run.title,
        customTitle: null,
        createdAt: openedAt,
        lastActivityAt: openedAt,
        model: meta.run.model,
        cwd: null,
        isWorktree: false,
        branch: null,
        status: "idle",
      }),
      provider: meta.run.provider,
      model: meta.run.model,
      status: busy ? "running" : listed?.status === "interrupted" ? "interrupted" : "idle",
    },
    meta.run.permissionMode,
  );
  const env = directory.environments.find((entry) => entry.environmentId === hostId);
  const firstPromptEditor = useRef<ComposerEditorHandle>(null);
  const [startingDraft, setStartingDraft] = useState<{
    media: DraftComposerAttachment[];
    count: number;
  } | null>(null);
  const showingDraft =
    isDraft &&
    (startingDraft !== null ||
      !feed.some((row) => row.type === "message" && row.message.role === "user"));
  const key = scopedThreadKey(EnvironmentId.make(hostId), ThreadId.make(id));
  const chooseDraftContext = (environment: boolean) => {
    const source =
      meta.attachments.length || meta.uploading ? { hostId, sessionId: id } : undefined;
    const saved =
      draftKey ??
      createNewTaskDraft({ environmentId: shell.environmentId, projectId: shell.projectId });
    if (!draftKey) {
      const draft = getComposerDraftSnapshot(key);
      setComposerDraftText(saved, draft.text);
      setComposerDraftContext(saved, draft.context);
    }
    if (environment)
      navigation.navigate("NewTaskEnvironment", { draftId: saved, environmentId: hostId, source });
    else navigation.navigate("NewTaskProject", { draftId: saved, source });
  };
  const project = directory.projects.find(
    (p) => p.environmentId === hostId && p.id === shell.projectId,
  );
  useRememberThreadProject(project ?? null);
  // A container is a codebase, not a project: a draft or a session in its folder names the codebase.
  const containerName = useListened(solus.codebases.changes, () =>
    project ? undefined : solus.codebases.containerCodebaseAt(hostId, shell.projectId)?.name,
  );
  const placeName = project?.title ?? containerName;
  const draftTitle =
    placeName ?? (isChat(meta.run.workingDirectory) ? "No project" : meta.run.workingDirectory);
  const edit = useQueuedRunEdit(key);
  const inputKey = draftKey ?? key;
  const composerKey = edit ? queuedEditDraftKey(key, edit.runId) : inputKey;
  const [savingEdit, setSavingEdit] = useState(false);
  const [editUploads, setEditUploads] = useState<(QueueAttachment & { previewUri: string })[]>([]);
  const [pickingEdit, setPickingEdit] = useState(false);
  const editRunId = edit?.runId;
  useEffect(() => {
    setEditUploads([]);
    setPickingEdit(false);
  }, [editRunId]);
  const currentEdit = useRef(editRunId);
  useLayoutEffect(() => {
    currentEdit.current = editRunId;
  }, [editRunId]);
  const pickFiles = async (pick: typeof pickComposerFiles) => {
    if (!controller.mayDrive) return false;
    if (edit && pickingEdit) return false;
    if (edit) setPickingEdit(true);
    return pick()
      .then(async (files) => {
        if (!files.length) return false;
        if (edit) {
          const uploads = await controller.uploadQueueFiles(files);
          if (currentEdit.current === edit.runId)
            setEditUploads((old) => [
              ...old,
              ...uploads.map((file, i) => ({ ...file, previewUri: files[i]!.uri })),
            ]);
        } else await controller.attach(files);
        return true;
      })
      .catch(() => {
        Alert.alert(
          "Could not attach file",
          "Check the file and the host connection, then try again.",
        );
        return false;
      })
      .finally(() => {
        if (edit && currentEdit.current === edit.runId) setPickingEdit(false);
      });
  };
  const firstQuestion = meta.questions.find((q) => !q.expired);
  const question = hasOwnCard(firstQuestion) ? null : firstQuestion;
  const pending = question
    ? {
        requestId: RuntimeRequestId.make(question.questionId),
        createdAt: shell.updatedAt,
        responseCapability: "live" as const,
        dismissible: false,
        questions: pendingInputQuestions(question),
      }
    : null;
  const [draftState, setDraftState] = useState<{
    id: string;
    drafts: Record<string, PendingUserInputDraftAnswer>;
  }>({ id: "", drafts: {} });
  const drafts = draftState.id === pending?.requestId ? draftState.drafts : {};
  const [respondingQuestion, setRespondingQuestion] = useState<string | null>(null);
  const answers = pending ? buildPendingUserInputAnswers(pending.questions, drafts) : null;
  const binding = {
    selectedThread: { ...shell, pendingBackgroundTasks: backgroundTasks(controller.model) },
    onStopBackgroundWork: () => void controller.stopBackgroundWork(),
    modelDisplayName: modelLabel(
      meta.run.provider,
      meta.run.model,
      meta.runOptions.agents?.find((agent) => agent.id === meta.run.provider),
    ),
    environmentId: EnvironmentId.make(hostId),
    projectWorkspaceRoot: meta.run.workingDirectory,
    threadCwd: meta.run.workingDirectory,
    selectedThreadDetailRef: null,
    selectedThreadFeed: feed,
    hostImageRenderer: (image) => (
      <ConversationMedia
        key={image.href}
        store={store}
        label={image.alt ?? image.title ?? "Image"}
        source={conversationImageSource(image.href)}
      />
    ),
    hostImageSource: (image) => resolveConversationImage(store, image.href),
    screenTone: connectionTone(env?.connectionState ?? "offline"),
    connectionError: meta.phase.kind === "error" ? meta.phase.message : null,
    contentPresentation:
      meta.phase.kind === "error" && (meta.phase.noAccess || !feed.length)
        ? { kind: "unavailable", title: "Session unavailable", detail: meta.phase.message }
        : { kind: feed.length || meta.phase.kind === "error" ? "ready" : meta.phase.kind },
    historyControls: {
      hasMoreHistory: meta.hasOlder,
      loading: meta.loadingOlder,
      error: meta.historyError,
      onLoadEarlier: () => void controller.loadOlder(),
      onLoadThrough: () => void controller.loadOlder(),
    },
    environmentLabel: env?.environmentLabel ?? null,
    connectionStateLabel: env?.connectionState ?? "offline",
    canOperateThread: controller.mayDrive,
    activeThreadBusy: busy,
    canStopThread: !showingDraft && meta.canStopTurn && controller.mayDrive,
    onStopThread: () =>
      void controller.stop().catch((e: Error) => Alert.alert("Stop failed", e.message)),
    onReconnectEnvironment: () => solus.connections.retry(hostId),
    onOpenConnectionEditor: () => navigation.navigate("SettingsEnvironments"),
    requestPanels:
      meta.permissions.length > 0 ||
      hasOwnCard(firstQuestion ?? meta.questions[0]) ||
      meta.pendingPlan ||
      meta.agentPlans.length > 0 ? (
        <RequestPanels store={store} meta={meta} />
      ) : null,
    composerCards: <RequestCards store={store} meta={meta} draft={showingDraft} />,
    privateInputActive: hasOwnCard(firstQuestion),
    mayAnswerRequests: controller.mayApprove,
    activePendingApproval: null,
    activePendingApprovals: [],
    respondingApprovalId: null,
    onRespondToApproval: async () => undefined,
    composerDraftKey: composerKey,
    onChangeDraftMessage: (text) => setComposerDraftText(composerKey, text),
    onSendCommand: async (text) => {
      if (!controller.mayDrive) return null;
      let commandId: MessageId | null = null;
      await controller.send(text, {
        onSubmitted: (id) => {
          commandId = MessageId.make(id);
        },
      });
      return commandId;
    },
    onSendMessage: async (action, before, onWillEnqueue) => {
      const draft = getComposerDraftSnapshot(composerKey);
      const prompt = sessionPromptText(draft.text, draft.context);
      if (edit) {
        if (
          pickingEdit ||
          (!draft.text.trim() && !edit.existingAttachments.length && !editUploads.length)
        )
          return null;
        const finish = startQueuedRunEditSave(key);
        if (!finish) return null;
        const entry = meta.queue.entries.find((e) => e.queueId === edit.runId);
        if (!entry) {
          finish(false);
          Alert.alert("Could not edit queued message", "This message already left the queue.");
          return null;
        }
        setSavingEdit(true);

        const attachments: QueueAttachment[] | undefined =
          edit.removedExistingAttachment || editUploads.length
            ? [
                ...hostQueueAttachments(entry).filter((file) =>
                  edit.existingAttachments.some((a) => a.id === file.id),
                ),
                ...editUploads.map(({ previewUri, ...file }) => file),
              ]
            : undefined;
        const change = controller.changeQueue({
          kind: "edit",
          queueId: edit.runId,
          revision: edit.hostRevision ?? 0,
          text: prompt,
          ...(attachments && {
            attachments,
            attachmentContext: attachments
              .filter((a) => a.type !== "image")
              .map((a) => a.context ?? `[Attached file: ${a.hostPath}]`)
              .join("\n"),
            imageRefs: attachments.flatMap((a) =>
              a.type === "image" && a.hostPath && !a.dataUrl
                ? [
                    {
                      hostPath: a.hostPath,
                      name: a.name,
                      mimeType: a.mimeType || "image/png",
                    },
                  ]
                : [],
            ),
            images: attachments.flatMap((a) =>
              a.type === "image" && a.dataUrl
                ? [{ dataUrl: a.dataUrl, mimeType: a.mimeType || "image/png" }]
                : [],
            ),
          }),
        });
        try {
          await change;
          finish(true);
          setComposerDraftText(composerKey, "");
          setSavingEdit(false);
          return edit.messageId;
        } catch (error) {
          finish(false);
          Alert.alert("Could not edit queued message", String(error));
          setSavingEdit(false);
          return null;
        }
      }
      if (
        (!draft.text.trim() && !controller.attachments.length && !controller.uploading) ||
        hasOwnCard(firstQuestion)
      )
        return null;
      const feedback = permissionForFeedback(meta.permissions);
      if (meta.permissions.some((p) => !p.expired)) {
        if (
          !feedback ||
          !controller.mayApprove ||
          controller.attachments.length ||
          controller.uploading
        )
          return null;
        if (await controller.answerPermission(feedback.questionId, feedback.denyOptionId, prompt)) {
          if (getComposerDraftSnapshot(inputKey).text === draft.text)
            setComposerDraftText(inputKey, "");
        }
        return null;
      }
      if (before && (await before(draft.text, false)) !== true) return null;
      if (!controller.mayDrive) return null;
      onWillEnqueue?.();
      if (showingDraft) {
        setStartingDraft({
          media: composerUploadMedia(id, meta.attachments, meta.pendingImages, meta.pendingVideos),
          count: meta.attachments.length + meta.uploading,
        });
      }
      return new Promise<MessageId | null>((resolve) => {
        let cleared = false;
        const accept = (messageId: string) => {
          if (showingDraft) {
            finishDraftSubmission(
              navigation,
              firstPromptEditor.current,
              inputKey,
              draft.text,
              hostId,
              id,
            );
            setStartingDraft(null);
          } else if (getComposerDraftSnapshot(inputKey).text === draft.text) {
            clearComposerDraftContent(inputKey);
            cleared = true;
          }
          resolve(MessageId.make(messageId));
        };
        const recover = () => {
          if (showingDraft) setStartingDraft(null);
          if (cleared) {
            void mergeComposerDraftContent(inputKey, draft).catch((error) =>
              Alert.alert("Could not restore draft", String(error)),
            );
          }
          resolve(null);
        };
        void controller
          .send(prompt, {
            delivery: action === "steer" ? "steer" : "queue",
            // Upstream leaves a new draft after its local save. An open thread
            // clears immediately and recovers its draft if that save fails.
            ...(showingDraft ? { onQueued: accept } : { onSubmitted: accept }),
            onUploadFailed: () => {
              recover();
              if (showingDraft)
                Alert.alert("Could not send prompt", "Check the attachments and try again.");
            },
          })
          .then(
            () => {
              if (showingDraft) setStartingDraft(null);
              resolve(null);
            },
            (error) => {
              recover();
              Alert.alert("Send failed", String(error));
            },
          );
      });
    },
    selectedThreadQueueCount: meta.queue.entries.length,
    showToolCalls: showToolCalls,
    followUpBehavior: AsyncResult.isSuccess(preferences)
      ? (preferences.value.followUpBehavior ?? "queue")
      : "queue",
    canSteerActiveTurn: busy,
    onResumeQueue: meta.queue.held ? () => controller.changeQueue({ kind: "resume" }) : null,
    queuedMessages,
    editHostQueuedMessage: !controller.mayDrive
      ? null
      : (message) => {
          if (!controller.mayDrive) return;
          const entry = store
            .metaSnapshotOf()
            .queue.entries.find(
              (entry) => (entry.clientPromptId ?? entry.queueId) === message.messageId,
            );
          if (!entry) return;
          const pending = hostQueueMessage(
            message.environmentId,
            message.threadId,
            entry,
            (path, refresh) =>
              resolveConversationImage(store, path, refresh).then((image) => image.uri),
          );
          beginQueuedRunEdit(
            scopedThreadKey(message.environmentId, message.threadId),
            {
              runId: RunId.make(entry.queueId),
              messageId: message.messageId,
              originalText: pending.text,
              hostRevision: pending.hostQueue.revision,
              existingAttachments: pending.hostQueue.attachments,
            },
            hostQueuedRuns(store),
          );
        },
    dispatchingMessageId: null,
    serverConfig: null,
    activePendingUserInput: pending,
    activePendingUserInputDrafts: drafts,
    activePendingUserInputAnswers: answers,
    respondingUserInputId: respondingQuestion ? RuntimeRequestId.make(respondingQuestion) : null,
    onSelectUserInputOption: (id, q, value) =>
      setDraftState({
        id,
        drafts: {
          ...drafts,
          [q.id]: toggleQuestionOption(q, drafts[q.id], value),
        },
      }),
    onChangeUserInputCustomAnswer: (id, key, value) =>
      setDraftState({ id, drafts: { ...drafts, [key]: typeQuestionRemark(drafts[key], value) } }),
    onSubmitUserInput: async () => {
      if (!pending || !answers || !controller.mayApprove || respondingQuestion) return;
      setRespondingQuestion(pending.requestId);
      await controller
        .answerQuestion(pending.requestId, pendingInputAnswers(pending.questions, drafts))
        .finally(() => setRespondingQuestion(null));
    },
    onDismissUserInput: async () => wip(),
    hostMedia: edit
      ? editUploads.flatMap((a): DraftComposerAttachment[] =>
          a.type === "image"
            ? [
                {
                  type: "image" as const,
                  id: a.id,
                  name: a.name,
                  sizeBytes: a.size ?? 0,
                  mimeType: a.mimeType || "image/png",
                  previewUri: a.previewUri,
                },
              ]
            : videoMimeType(a)
              ? [
                  {
                    type: "file",
                    id: a.id,
                    name: a.name,
                    sizeBytes: a.size ?? 0,
                    mimeType: videoMimeType(a)!,
                    fileUri: a.previewUri,
                  },
                ]
              : [],
        )
      : (startingDraft?.media ??
        composerUploadMedia(id, meta.attachments, meta.pendingImages, meta.pendingVideos)),
    hostAttachmentCount: edit
      ? editUploads.length + Number(pickingEdit)
      : (startingDraft?.count ?? meta.attachments.length + meta.uploading),
    onPickDraftMedia: async () => {
      await pickFiles(pickComposerMedia);
    },
    onPickDraftFiles: async () => {
      await pickFiles(pickComposerFiles);
    },
    onNativePasteImages: (uris) => pickFiles(() => pastedComposerImages(uris)),
    onNativePasteText: async (paste) =>
      setComposerDraftText(composerKey, getComposerDraftSnapshot(composerKey).text + paste.text),
    onRemoveDraftImage: (id) =>
      edit
        ? setEditUploads((files) => files.filter((f) => f.id !== id))
        : controller.removeAttachment(id),
    feedbackSubmissions: [],
    onDismissFeedback: wip,
    activityRun: null,
    runlessWorkActive: busy,
    activeWorkStartedAt: busy
      ? feed.findLast((entry) => entry.type === "message" && entry.message.role === "user")
          ?.createdAt || null
      : null,
    isCompacting: false,
    creationState: null,
    queuedRunEdit: edit,
    isSavingQueuedEdit: savingEdit,
    onCancelQueuedRunEdit: () => endQueuedRunEdit(key),
    onRemoveQueuedEditAttachment: (id) => removeQueuedRunEditAttachment(key, id),
    canSwitchThreadProvider: false,
    offersSideChat: false,
  } satisfies Omit<ThreadDetailScreenProps, "header">;
  return {
    binding,
    draft: showingDraft
      ? {
          editorRef: firstPromptEditor,
          disabled: startingDraft !== null || !controller.mayDrive,
          scratch: isChat(meta.run.workingDirectory),
          title: draftTitle,
          chooseProject: () => chooseDraftContext(false),
          chooseEnvironment: () => chooseDraftContext(true),
          environmentLabel: env?.environmentLabel ?? hostId,
          connectionState: env?.connectionState ?? ("offline" as const),
        }
      : null,
    header: {
      controller,
      draftKey: showingDraft ? draftKey : undefined,
      cwd: meta.run.workingDirectory,
      projectName: draftTitle,
      title: shell.title,
      subtitle: showingDraft
        ? ""
        : [placeName, env?.environmentLabel].filter(Boolean).join(" · "),
      draft: showingDraft,
    },
  };
}
