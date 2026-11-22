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
import { modelLabel } from "@solus-mobile/features/conversation/lib/run-settings";
import { RequestCards } from "./RequestCards";
import {
  ConversationMedia,
  conversationImageSource,
  resolveConversationImage,
} from "./ConversationMedia";
import { ThreadMcpApp } from "@solus-mobile/features/threads/ThreadMcpApp";
import { ConversationCard } from "./ConversationCard";
import { NewTaskRouteScreen } from "../features/threads/NewTaskRouteScreen";
import { scopedThreadKey } from "../lib/scopedEntities";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
import { getComposerDraftSnapshot, setComposerDraftText } from "../state/use-composer-drafts";
import { solus, useSolusDirectory } from "./runtime";
import { toThreadShell } from "./session";
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
  const [newId] = useState(() => solus.newSessionId());
  const hostId =
    params.environmentId ?? first(draft?.environmentId) ?? directory.environments[0]?.environmentId;
  const id = params.threadId ?? newId;
  const path =
    first(draft?.projectId) ??
    directory.projects.find((p) => p.environmentId === hostId)?.workspaceRoot ??
    "~";
  const listed = hostId ? solus.threads.thread(hostId, id) : null;
  const [store, setStore] = useState<ConversationStore | null>(null);
  const record = listed?.record;
  useEffect(() => {
    if (!hostId || (draft && (!draft.environmentId || !draft.projectId)) || (!draft && !record))
      return;
    const existing = solus.conversation(
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
    return () => {
      if (existing) solus.closeConversation(existing);
    };
  }, [hostId, id, path, !!draft, !draft && !!record]);
  // A session that the host saved must open under its durable ID on the next launch.
  useEffect(() => {
    if (draft && record && hostId) {
      navigation.dispatch(CommonActions.setParams(submittedThreadParams(hostId, id)));
    }
  }, [draft, !!record, hostId, id, navigation]);
  if (draft && (!draft.environmentId || !draft.projectId))
    return <NewTaskRouteScreen route={{ params: undefined }} />;
  if (!store || !hostId)
    return (
      <View className="flex-1 justify-center items-center bg-screen">
        <AppText>
          {directory.state.isLoadingConnections || directory.state.hasPendingShellSnapshot
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
  return (
    <AppProvider app={solus}>
      <SessionDetail key={id} store={store} hostId={hostId} id={id} />
    </AppProvider>
  );
}

function useFeed(store: ConversationStore, id: string) {
  const order = useSyncExternalStore(store.order.subscribe, store.orderSnapshot);
  const reader = useMemo(() => {
    return conversationFeed(store, order, id, (key, superseded, liveAppOnly) =>
      liveAppOnly ? (
        <ThreadMcpApp store={store} id={key} />
      ) : (
        <ConversationCard key={key} store={store} id={key} superseded={superseded} />
      ),
    );
  }, [store, order, id]);
  return useSyncExternalStore(reader.subscribe, reader.get);
}

function SessionDetail({
  store,
  hostId,
  id,
}: {
  store: ConversationStore;
  hostId: string;
  id: string;
}) {
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
  const key = scopedThreadKey(EnvironmentId.make(hostId), ThreadId.make(id));
  const pickFiles = async (pick: typeof pickComposerFiles) => {
    if (!controller.mayDrive) return false;
    try {
      const files = await pick(controller.attachments.length + controller.uploading);
      if (!files.length) return false;
      await controller.attach(files);
      return true;
    } catch {
      Alert.alert(
        "Could not attach file",
        "Check the file and the host connection, then try again.",
      );
      return false;
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
          modelDisplayName={modelLabel(meta.run.provider, meta.run.model, meta.runOptions.agents?.find((agent) => agent.id === meta.run.provider))}
          environmentId={EnvironmentId.make(hostId)}
          projectWorkspaceRoot={controller.run.workingDirectory}
          threadCwd={controller.run.workingDirectory}
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
            meta.phase.kind === "error"
              ? { kind: "unavailable", title: "Session unavailable", detail: meta.phase.message }
              : { kind: meta.phase.kind }
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
          composerDraftKey={key}
          onChangeDraftMessage={(text) => setComposerDraftText(key, text)}
          onSendCommand={send}
          onSendMessage={async (action, before, onWillEnqueue) => {
            const draft = getComposerDraftSnapshot(key);
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
                if (getComposerDraftSnapshot(key).text === draft.text)
                  setComposerDraftText(key, "");
              }
              return null;
            }
            if (before && (await before(draft.text, false)) !== true) return null;
            onWillEnqueue?.();
            try {
              const sent = await send(draft.text, action === "steer" ? "steer" : "queue");
              if (sent && getComposerDraftSnapshot(key).text === draft.text)
                setComposerDraftText(key, "");
              return sent;
            } catch (error) {
              Alert.alert("Send failed", String(error));
              return null;
            }
          }}
          selectedThreadQueueCount={meta.queue.entries.length}
          followUpBehavior="queue"
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
          hostAttachmentCount={meta.attachments.length + meta.uploading}
          onPickDraftMedia={async () => {
            await pickFiles(pickComposerMedia);
          }}
          onPickDraftFiles={async () => {
            await pickFiles(pickComposerFiles);
          }}
          onNativePasteImages={(uris) => pickFiles(pastedComposerImages([...uris]))}
          onNativePasteText={async (paste) =>
            setComposerDraftText(key, getComposerDraftSnapshot(key).text + paste.text)
          }
          onRemoveDraftImage={(id) => controller.removeAttachment(id)}
          feedbackSubmissions={[]}
          onDismissFeedback={wip}
          activityRun={null}
          activeWorkStartedAt={null}
          isCompacting={false}
          creationState={null}
          queuedRunEdit={null}
          isSavingQueuedEdit={false}
          onCancelQueuedRunEdit={wip}
          onRemoveQueuedEditAttachment={wip}
          canSwitchThreadProvider={false}
          offersSideChat={false}
        />
      </ScreenContent>
    </View>
  );
}
