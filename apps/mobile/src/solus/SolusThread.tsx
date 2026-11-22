import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { mobilePreferencesAtom } from "../state/preferences";
import {
  DraftViewport,
  NewTaskProjectHero,
  SHORT_DRAFT_VIEWPORT_HEIGHT,
} from "../features/threads/NewTaskHero";
import type { ComposerEditorHandle } from "../components/ComposerEditor";
import { DraftEnvironmentControl } from "../features/threads/DraftEnvironmentControl";
import {
  useQueuedRunEdit,
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
import { formatAnswer } from "@solus/contracts/question-answer";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import { connectionTone } from "../features/connection/connectionTone";
import { AppProvider } from "@solus-mobile/app/app-context";
import { permissionForFeedback } from "@solus-mobile/features/conversation/lib/pending-requests";
import {
  pickComposerMedia,
  pickComposerFiles,
  pastedComposerImages,
} from "@solus-mobile/features/threads/composer-attachment-pickers";
import { TurnDiffReader } from "./turn-diff-context";
import { modelLabel } from "@solus-mobile/features/conversation/lib/run-settings";
import { RequestCards } from "./RequestCards";
import {
  ConversationMedia,
  conversationImageSource,
  resolveConversationImage,
} from "./ConversationMedia";
import { ThreadMcpApp } from "@solus-mobile/features/threads/ThreadMcpApp";
import { ConversationCard } from "./ConversationCard";
import { scopedThreadKey } from "../lib/scopedEntities";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, View } from "react-native";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { EnvironmentId, MessageId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { isSessionBusyStatus } from "@solus/contracts/types";
import type { ConversationStore } from "@solus-mobile/features/conversation/conversation-store";
import { ThreadDetailScreen } from "../features/threads/ThreadDetailScreen";
import { AppText } from "../components/ui/AppText";
import { ScreenContent } from "../components/ui/ScreenContent";
import { AppBar } from "../components/ui/AppBar";
import { conversationFeed } from "./conversation-feed";
import {
  createNewTaskDraft,
  getComposerDraftSnapshot,
  setComposerDraftText,
} from "../state/use-composer-drafts";
import { solus, useSolusDirectory } from "./runtime";
import { toThreadShell } from "./session";
import { waitingForSessionList } from "./workspace-state";
import {
  submittedThreadParams,
  type NewTaskDraftRouteParams,
} from "../features/threads/thread-route-state";

const wip = () => Alert.alert("WIP");
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function SolusThread({
  params,
}: {
  params: { environmentId?: string; threadId?: string; draft?: NewTaskDraftRouteParams };
}) {
  const directory = useSolusDirectory();
  const navigation = useNavigation();
  const draft = params.draft;
  const newId = useMemo(
    () => solus.newSessionId(),
    [draft?.requestId, first(draft?.draftId), first(draft?.projectId), first(draft?.environmentId)],
  );
  const hostId =
    params.environmentId ?? first(draft?.environmentId) ?? directory.environments[0]?.environmentId;
  const id = params.threadId ?? newId;
  const path =
    first(draft?.projectId) ??
    directory.projects.find((p) => p.environmentId === hostId)?.workspaceRoot ??
    "~";
  const listed = hostId ? solus.threads.thread(hostId, id) : null;
  const [store, setStore] = useState<ConversationStore | null>(() => hostId ? solus.openConversation(hostId, id) : null);
  const record = listed?.record;
  const scope = solus.sessionCache.scope();
  const canOpen = !!(record || draft || (hostId && solus.openConversation(hostId, id)));
  useEffect(() => {
    if (!hostId || !canOpen) {
      setStore(null);
      return;
    }
    const existing =
      solus.openConversation(hostId, id) ??
      solus.conversation(
        hostId,
        draft
          ? {
              newSession: {
                sessionId: id,
                workingDirectory: path,
                provider: solus.personal.current().activeAgent,
              },
            }
          : { record },
      );
    setStore(existing);
    return existing ? solus.observeConversation(existing) : undefined;
  }, [scope, hostId, id, canOpen]);
  // A session that the host saved must open under its durable ID on the next launch.
  useEffect(() => {
    if (draft && record && hostId) {
      navigation.dispatch(CommonActions.setParams(submittedThreadParams(hostId, id)));
    }
  }, [draft, !!record, hostId, id, navigation]);
  if (
    !store ||
    !hostId ||
    store.controller.run.sessionId !== id ||
    store.controller.hostId !== hostId
  ) {
    const host = hostId ? directory.hostsById[hostId] : undefined;
    const opening =
      directory.state.isLoadingConnections ||
      host?.connectionState === "connecting" ||
      host?.connectionState === "reconnecting" ||
      (host?.connectionState === "connected" &&
        (!!(draft || record) || waitingForSessionList(solus.threads.stateOf(host.environmentId))));
    return (
      <View className="flex-1 justify-center items-center bg-screen">
        <AppText>
          {opening
            ? "Opening session…"
            : (directory.state.shellSnapshotError ?? "Session unavailable")}
        </AppText>
        {!hostId && (
          <AppText onPress={() => navigation.navigate("SettingsEnvironmentNew")}>
            Connect an environment
          </AppText>
        )}
      </View>
    );
  }
  return (
    <AppProvider app={solus}>
      <TurnDiffReader.Provider value={store.controller.readTurnDiff}>
        <SessionDetail
          draftKey={first(draft?.draftId)}
          isDraft={!!draft}
          key={id}
          store={store}
          hostId={hostId}
          id={id}
        />
      </TurnDiffReader.Provider>
    </AppProvider>
  );
}

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

function SessionDetail({
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
  const showToolCalls = useSyncExternalStore(solus.personal.changes.subscribe,()=>solus.personal.current().showToolCalls);
  const controller = store.controller;
  const meta = useSyncExternalStore(store.meta.subscribe, store.metaSnapshotOf);
  const feed = useFeed(store, id);
  const directory = useSolusDirectory();
  const navigation = useNavigation();
  const [openedAt] = useState(Date.now);
  const listed = solus.threads.thread(hostId, id)?.record;
  const busy = isSessionBusyStatus(meta.status);
  const shell = toThreadShell(
    hostId,
    {
      ...(listed ?? {
        sessionId: id,
        provider: meta.run.provider,
        projectPath: controller.run.workingDirectory,
        title: controller.run.title,
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
  const editorRef = useRef<ComposerEditorHandle>(null);
  const chooseProject = () => {
    const saved =
      draftKey ??
      createNewTaskDraft({ environmentId: shell.environmentId, projectId: shell.projectId });
    if (!draftKey) setComposerDraftText(saved, getComposerDraftSnapshot(key).text);
    navigation.navigate("NewTaskProject", { draftId: saved });
  };
  const project = directory.projects.find(
    (p) => p.environmentId === hostId && p.id === shell.projectId,
  );
  useRememberThreadProject(project ?? null);
  const draftTitle =
    project?.title ??
    (isChat(controller.run.workingDirectory) ? "No project" : controller.run.workingDirectory);
  const environmentControl = (
    <DraftEnvironmentControl
      connectionState={env?.connectionState ?? "offline"}
      label={env?.environmentLabel ?? hostId}
      machineKind="server"
      disabled={!controller.mayDrive}
      onChooseEnvironment={chooseProject}
    />
  );
  const key = scopedThreadKey(EnvironmentId.make(hostId), ThreadId.make(id));
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
  currentEdit.current = editRunId;
  const pickFiles = async (pick: typeof pickComposerFiles) => {
    if (!controller.mayDrive) return false;
    try {
      const count = edit
        ? editUploads.length + edit.existingAttachments.length
        : controller.attachments.length + controller.uploading;
      if (edit && pickingEdit) return false;
      if (edit) setPickingEdit(true);
      const files = await pick(count);
      if (!files.length) return false;
      if (edit) {
        const uploads = await controller.uploadQueueFiles(files, count);
        if (currentEdit.current === edit.runId)
          setEditUploads((old) => [
            ...old,
            ...uploads.map((file, i) => ({ ...file, previewUri: files[i]!.uri })),
          ]);
      } else await controller.attach(files);
      return true;
    } catch {
      Alert.alert(
        "Could not attach file",
        "Check the file and the host connection, then try again.",
      );
      return false;
    } finally {
      if (edit && currentEdit.current === edit.runId) setPickingEdit(false);
    }
  };
  const send = async (text: string, delivery?: "steer" | "queue") => {
    if (
      !controller.mayDrive ||
      (!text.trim() && !controller.attachments.length && !controller.uploading)
    )
      return null;
    const before = store.orderSnapshot().length;
    const pending = controller.send(text, { delivery });
    const prompt = store
      .orderSnapshot()
      .slice(before)
      .find((key) => store.item(key)?.kind === "user");
    await pending;
    // A failed upload returns the prompt to the composer. It still owns the typed draft.
    if (controller.takeUnsentText() !== null) return null;
    return prompt ? MessageId.make(prompt) : null;
  };
  const firstQuestion = meta.questions.find((q) => !q.expired);
  const question = firstQuestion?.kind === "secret" ? null : firstQuestion;
  const pending = question
    ? {
        requestId: RuntimeRequestId.make(question.questionId),
        createdAt: shell.updatedAt,
        responseCapability: "live" as const,
        dismissible: false,
        questions: question.questions.map((q) => ({
          id: q.id ?? q.question,
          header: q.header ?? q.question,
          question: q.question,
          multiSelect: q.multiSelect,
          options: q.options.map((o) => ({ ...o, description: o.description ?? "" })),
        })),
      }
    : null;
  const [draftState, setDraftState] = useState<{
    id: string;
    drafts: Record<string, PendingUserInputDraftAnswer>;
  }>({ id: "", drafts: {} });
  const drafts = draftState.id === pending?.requestId ? draftState.drafts : {};
  const [respondingQuestion, setRespondingQuestion] = useState<string | null>(null);
  const answers = pending ? buildPendingUserInputAnswers(pending.questions, drafts) : null;
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={shell.title} onBack={() => navigation.goBack()} />
      <ScreenContent surface="canvas">
        <ThreadDetailScreen
          selectedThread={shell}
          modelDisplayName={modelLabel(
            meta.run.provider,
            meta.run.model,
            meta.runOptions.agents?.find((agent) => agent.id === meta.run.provider),
          )}
          environmentId={EnvironmentId.make(hostId)}
          projectWorkspaceRoot={controller.run.workingDirectory}
          threadCwd={controller.run.workingDirectory}
          draftMode={
            isDraft && !feed.length
              ? {
                  editorRef,
                  interactionLocked: !controller.mayDrive,
                  sendBlockedReason: null,
                  content: (headerInset, bottomInset, viewportHeight) => (
                    <DraftViewport {...{ headerInset, bottomInset, viewportHeight }}>
                      <NewTaskProjectHero
                        title={draftTitle}
                        disabled={!controller.mayDrive}
                        chooseProject={chooseProject}
                      >
                        {environmentControl}
                      </NewTaskProjectHero>
                    </DraftViewport>
                  ),
                  controls: (height) =>
                    height < SHORT_DRAFT_VIEWPORT_HEIGHT ? environmentControl : null,
                }
              : undefined
          }
          selectedThreadDetailRef={null}
          selectedThreadFeed={feed}
          hostImageRenderer={(image) => (
            <ConversationMedia
              key={image.href}
              store={store}
              label={image.alt ?? image.title ?? "Image"}
              source={conversationImageSource(image.href)}
            />
          )}
          hostImageSource={(image) => resolveConversationImage(store, image.href)}
          screenTone={connectionTone(env?.connectionState ?? "offline")}
          connectionError={meta.phase.kind === "error" ? meta.phase.message : null}
          contentPresentation={
            meta.phase.kind === "error" && (meta.phase.noAccess || !feed.length)
              ? { kind: "unavailable", title: "Session unavailable", detail: meta.phase.message }
              : { kind: feed.length || meta.phase.kind === "error" ? "ready" : meta.phase.kind }
          }
          historyControls={{
            hasMoreHistory: meta.hasOlder,
            loading: meta.loadingOlder,
            error: null,
            onLoadEarlier: () => void controller.loadOlder(),
            onLoadThrough: () => void controller.loadOlder(),
          }}
          environmentLabel={env?.environmentLabel ?? null}
          connectionStateLabel={env?.connectionState ?? "offline"}
          canOperateThread={controller.mayDrive}
          activeThreadBusy={busy}
          canStopThread={busy && controller.mayDrive}
          onStopThread={() =>
            void controller.stop().catch((e: Error) => Alert.alert("Stop failed", e.message))
          }
          onReconnectEnvironment={() => solus.connections.retry(hostId)}
          onOpenConnectionEditor={() => navigation.navigate("SettingsEnvironments")}
          composerCards={<RequestCards store={store} meta={meta} />}
          privateInputActive={firstQuestion?.kind === "secret"}
          mayAnswerRequests={controller.mayApprove}
          activePendingApproval={null}
          activePendingApprovals={[]}
          respondingApprovalId={null}
          onRespondToApproval={async () => undefined}
          composerDraftKey={composerKey}
          onChangeDraftMessage={(text) => setComposerDraftText(composerKey, text)}
          onSendCommand={send}
          onSendMessage={async (action, before, onWillEnqueue) => {
            const draft = getComposerDraftSnapshot(composerKey);
            if (edit) {
              if (
                pickingEdit ||
                (!draft.text.trim() && !edit.existingAttachments.length && !editUploads.length)
              )
                return null;
              const finish = startQueuedRunEditSave(key);
              if (!finish) return null;
              setSavingEdit(true);
              try {
                const entry = meta.queue.entries.find((e) => e.queueId === edit.runId);
                if (!entry) throw new Error("This message already left the queue.");
                const attachments: QueueAttachment[] | undefined =
                  edit.removedExistingAttachment || editUploads.length
                    ? [
                        ...(entry.attachments ?? []).filter((file) =>
                          edit.existingAttachments.some((a) => a.id === file.id),
                        ),
                        ...editUploads.map(({ previewUri, ...file }) => file),
                      ]
                    : undefined;
                await controller.changeQueue({
                  kind: "edit",
                  queueId: edit.runId,
                  revision: edit.hostRevision ?? 0,
                  text: draft.text,
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
                finish(true);
                setComposerDraftText(composerKey, "");
                return edit.messageId;
              } catch (error) {
                finish(false);
                Alert.alert("Could not edit queued message", String(error));
                return null;
              } finally {
                setSavingEdit(false);
              }
            }
            if (
              (!draft.text.trim() && !controller.attachments.length && !controller.uploading) ||
              firstQuestion?.kind === "secret"
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
              if (
                await controller.answerPermission(
                  feedback.questionId,
                  feedback.denyOptionId,
                  draft.text,
                )
              ) {
                if (getComposerDraftSnapshot(inputKey).text === draft.text)
                  setComposerDraftText(inputKey, "");
              }
              return null;
            }
            if (before && (await before(draft.text, false)) !== true) return null;
            onWillEnqueue?.();
            try {
              const sent = await send(draft.text, action === "steer" ? "steer" : "queue");
              if (sent && getComposerDraftSnapshot(inputKey).text === draft.text)
                setComposerDraftText(inputKey, "");
              return sent;
            } catch (error) {
              Alert.alert("Send failed", String(error));
              return null;
            }
          }}
          selectedThreadQueueCount={meta.queue.entries.length}
          showToolCalls={showToolCalls}
          followUpBehavior={AsyncResult.isSuccess(preferences) ? preferences.value.followUpBehavior ?? "queue" : "queue"}
          canSteerActiveTurn={busy}
          onResumeQueue={meta.queue.held ? () => controller.changeQueue({ kind: "resume" }) : null}
          queuedMessages={[]}
          dispatchingMessageId={null}
          serverConfig={null}
          activePendingUserInput={pending}
          activePendingUserInputDrafts={drafts}
          activePendingUserInputAnswers={answers}
          respondingUserInputId={
            respondingQuestion ? RuntimeRequestId.make(respondingQuestion) : null
          }
          onSelectUserInputOption={(id, q, value) =>
            setDraftState({
              id,
              drafts: {
                ...drafts,
                [q.id]: togglePendingUserInputOptionSelection(q, drafts[q.id], value),
              },
            })
          }
          onChangeUserInputCustomAnswer={(id, key, value) => {
            const q = pending?.questions.find((item) => item.id === key);
            if (q)
              setDraftState({
                id,
                drafts: {
                  ...drafts,
                  [key]: setPendingUserInputCustomAnswer(q, drafts[key], value),
                },
              });
          }}
          onSubmitUserInput={async () => {
            if (!pending || !answers || !controller.mayApprove || respondingQuestion) return;
            setRespondingQuestion(pending.requestId);
            try {
              await controller.answerQuestion(
                pending.requestId,
                Object.fromEntries(
                  pending.questions.map((q) => [
                    q.id,
                    formatAnswer(
                      drafts[q.id]?.selectedOptionValues?.join(", ") ?? "",
                      drafts[q.id]?.customAnswer,
                    ),
                  ]),
                ),
              );
            } finally {
              setRespondingQuestion(null);
            }
          }}
          onDismissUserInput={async () => wip()}
          hostMedia={
            edit
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
                    : videoMimeType(a) ? [{ type: "file", id: a.id, name: a.name, sizeBytes: a.size ?? 0, mimeType: videoMimeType(a)!, fileUri: a.previewUri }] : [],
                )
              : composerUploadMedia(meta.attachments, meta.pendingImages, meta.pendingVideos)
          }
          hostAttachmentCount={
            edit
              ? editUploads.length + Number(pickingEdit)
              : meta.attachments.length + meta.uploading
          }
          onPickDraftMedia={async () => {
            await pickFiles(pickComposerMedia);
          }}
          onPickDraftFiles={async () => {
            await pickFiles(pickComposerFiles);
          }}
          onNativePasteImages={(uris) => pickFiles(pastedComposerImages([...uris]))}
          onNativePasteText={async (paste) =>
            setComposerDraftText(
              composerKey,
              getComposerDraftSnapshot(composerKey).text + paste.text,
            )
          }
          onRemoveDraftImage={(id) =>
            edit
              ? setEditUploads((files) => files.filter((f) => f.id !== id))
              : controller.removeAttachment(id)
          }
          feedbackSubmissions={[]}
          onDismissFeedback={wip}
          activityRun={null}
          runlessWorkActive={busy}
          activeWorkStartedAt={
            busy
              ? feed.findLast((entry) => entry.type === "message" && entry.message.role === "user")
                  ?.createdAt || null
              : null
          }
          isCompacting={false}
          creationState={null}
          queuedRunEdit={edit}
          isSavingQueuedEdit={savingEdit}
          onCancelQueuedRunEdit={() => endQueuedRunEdit(key)}
          onRemoveQueuedEditAttachment={(id) => removeQueuedRunEditAttachment(key, id)}
          canSwitchThreadProvider={false}
          offersSideChat={false}
        />
      </ScreenContent>
    </View>
  );
}
