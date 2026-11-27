import { sessionWorktreeSetup } from "./session-worktree-setup";
import { pendingWorktreeSetupCard, settleSetupCard } from "@solus/contracts/setup-card";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AppProvider } from "@solus-mobile/app/app-context";
import type { SecretTextInputProps } from "../components/ui/SecretTextInput.types";
import { SolusApp } from "@solus-mobile/app/solus-app";
import { memoryKeyValueStore, memorySecretStore } from "@solus-mobile/platform/ports";
import { hasOwnCard, type PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { WsTransport } from "@solus/client-core/ws-transport";
import { RequestPanels } from "./RequestCards";
import {
  hostApprovalCard,
  hostApprovalResponder,
  sendHostApprovalFeedback,
  useHostApprovalResponses,
} from "./approval-requests";
import { PendingApprovalCard } from "../features/threads/PendingApprovalCard";
import { TurnDiffReader } from "./turn-diff-context";
import { AssistantReplyMarkdown } from "./AssistantReplyMarkdown";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ThreadSubagentGroup } from "../features/threads/thread-subagent-group";
import { conversationFeed } from "./conversation-feed";
import { remoteAgentChild } from "./agent-child-host";
import { ConversationCard } from "./ConversationCard";
import { BackgroundCommandRow } from "../features/threads/BackgroundCommandRow";

vi.mock("../features/pull-requests/PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ markdown }: { markdown: string }) => <span>{markdown}</span>,
}));
vi.mock("../features/pull-requests/guide/GuideOutline", () => ({
  GuideOutline: ({ onOpen }: { onOpen: (index: number) => void }) => <button onClick={() => onOpen(0)}>Open stop</button>,
}));
vi.mock("../features/pull-requests/guide/ReviewGuideExcerpt", () => ({
  ReviewGuideExcerpt: ({ patch }: { patch: string }) => <pre>{patch}</pre>,
}));

const host = vi.hoisted(() => ({
  navigate: vi.fn(),
  inspect: vi.fn(() => false),
  dispatch: vi.fn(),
  remember: vi.fn(),
  read: vi.fn(async (id: string) => ({ sessionId: id })),
  recordOpen: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: host.dispatch, navigate: host.navigate, getState: () => undefined }),
  useRoute: () => ({ name: "Thread", params: { environmentId: "host", threadId: "session" } }),
  StackActions: {
    push: (name: string, params: { environmentId: string; threadId: string }) => ({ name, params }),
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ActivityIndicator: () => null,
  Modal: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ onPress, children, accessibilityLabel, disabled }: { disabled?: boolean; onPress: () => void; children: ReactNode; accessibilityLabel?: string }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>{children}</button>
  ),
  Alert: { alert: vi.fn() },
  useWindowDimensions: () => ({ height: 800, width: 360 }),
}));
vi.mock("../components/ui/AppText", () => ({
  AppTextInput: () => <input />,
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@solus-mobile/components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@solus-mobile/components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../components/ui/SecretTextInput", () => ({
  SecretTextInput: (props: SecretTextInputProps) => (
    <input aria-label={props.accessibilityLabel} disabled={!props.editable} value={props.value}
      onChange={event => props.onChangeText(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key === "Enter") props.onSubmitEditing(event.currentTarget.value);
      }}
    />
  ),
}));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: () => false }));
vi.mock("../features/threads/thread-inspector-navigation", async () => ({
  ThreadInspectorNavigationContext: (await import("react")).createContext(null),
  useOpenThreadInspector: () => host.inspect,
}));
vi.mock("./host-query", () => ({hostQuery: vi.fn()}));
vi.mock("../state/host-query-scope", () => ({hostQueryScope: () => "mac/current"}));
vi.mock("./runtime", () => ({
  solus: {
    cloudSessions: {headFor: () => null},
    account: {organizationId: null},
    threads: { thread: () => null, cloudHostIds: () => new Set(), rememberSearchResult: host.remember },
    connections: { state: () => undefined, connection: () => ({ api: { sessionRecordGet: host.read } }) },
    registry: { host: () => ({ label: "Host" }) },
    history: { record: host.recordOpen },
    // A started session's card reads its agent activity from the thread list.
    threadList: { changes: { subscribe: () => () => {} }, facts: () => ({ agentActivity: new Map() }) },
  },
}));
// The dots read app state and screen focus; these tests are about what a card opens.
vi.mock("../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../features/threads/use-visible-second-clock", () => ({ useVisibleSecondClock: () => 0 }));
vi.mock("../components/ui/DotMatrix", () => ({ DotMatrix: () => null }));
vi.mock("../features/threads/LinkRequestCard", () => ({
  LinkRequestCard: ({
    sessionHostId,
    onAnswer,
  }: {
    sessionHostId: string;
    onAnswer: (answers: Record<string, string>) => void;
  }) => (
    <button
      onClick={() => onAnswer({ status: "added", installationId: "win", way: "ssh" })}
    >
      Add machine on {sessionHostId}
    </button>
  ),
}));
vi.mock("../features/threads/CloudMachineCard", () => ({
  CloudMachineCard: ({ ask, onAnswer }: { ask: { mode: string }; onAnswer: (answers: Record<string, string>) => void }) => (
    <button onClick={() => onAnswer({ status: "chosen", organizationId: "acme" })}>Cloud machine {ask.mode}</button>
  ),
}));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("../state/threads", () => ({ environmentThreadDetails: { threadAtom: () => null } }));
vi.mock("@effect/atom-react", async (original) => ({
  ...await original<typeof import("@effect/atom-react")>(), useAtomValue: () => null,
}));
vi.mock("../state/entities", () => ({ useServerConfigs: () => new Map(), useThreadShell: () => null, useEnvironmentServerConfig: () => null, useProject: () => null }));
vi.mock("../state/linkedThread", () => ({
  useLinkedThreadReach: () => ({ ownConnection: () => undefined, isLinked: () => true }),
}));
vi.mock("../features/threads/ThreadFeed", () => ({
  useMarkdownStyles: () => ({ assistant: { nativeTextStyle: {} } }),
}));
vi.mock("../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({ markdown }: { markdown: string }) => <span>{markdown}</span>,
}));
vi.mock("./ConversationMedia", () => ({
  ConversationMedia: ({ label }: { label: string }) => <span>{label}</span>,
}));
vi.mock("../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../state/assets", () => ({}));
vi.mock("../lib/openExternalUrl", () => ({ tryOpenExternalUrl: vi.fn() }));
vi.mock("../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => async () => false }));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeId: "default",
    themeAppearance: "dark",
    themeVariables: {},
  }),
}));
vi.mock("../lib/htmlRenderTheme", () => ({
  mobileHtmlRenderTheme: () => ({ appearance: "dark", variables: { "--background": "#101010" } }),
}));
vi.mock("react-native-webview", () => ({
  WebView: ({
    source,
    accessibilityLabel,
  }: {
    source: { html: string };
    accessibilityLabel: string;
  }) => <div data-page={source.html} aria-label={accessibilityLabel} />,
}));
vi.mock("@solus-mobile/features/threads/ThreadMcpApp", () => ({
  canShowLiveApp: () => false,
  ThreadMcpApp: () => null,
}));
vi.mock("@solus-mobile/features/threads/ThreadToolAudio", () => ({ ThreadToolAudio: () => null }));
vi.mock("@solus-mobile/features/threads/WorktreeOfferCard", () => ({
  WorktreeOfferCard: () => null,
}));
vi.mock("@solus-mobile/features/threads/RequestActionButton", () => ({
  RequestActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("@solus-mobile/features/threads/ThreadMcpPipDock", () => ({
  ThreadMcpPipDock: () => null,
}));
vi.mock("../features/threads/CopyTextButton", () => ({ CopyTextButton: () => null }));
vi.mock("../components/ui/Button", () => ({
  Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) =>
    <button disabled={disabled} onClick={onPress}>{label}</button>,
}));
vi.mock("gt-react-native", async (importOriginal) => {
  const { gtFallback } = await importOriginal<typeof import("gt-react-native")>();
  return {
    msg: (value: string) => value,
    Var: ({children}: {children: ReactNode}) => <>{children}</>,
    T: ({children}: {children: ReactNode}) => <>{children}</>,
    useGT: () => gtFallback,
    useMessages: () => (value: string) => value,
  };
});
vi.mock("@solus-mobile/features/threads/PendingSecretCard", () => ({
  PendingSecretCard: ({ onSubmit }: { onSubmit: (values: (string | null)[]) => void }) => (
    <button onClick={() => onSubmit(["fixture", null])}>Submit private answer</button>
  ),
}));

async function fixture() {
  let next = 0;
  const app = new SolusApp({
    storage: memoryKeyValueStore(),
    secrets: memorySecretStore(),
    fetch: () => new Promise<Response>(() => {}),
    createTransport: (o) => new WsTransport(o),
    openBrowser: async () => {},
    deviceLabel: "Test",
    uuid: () => "fixture-" + ++next,
  });
  await app.registry.load();
  await app.registry.savePaired(
    { id: "host", url: "http://host.invalid", label: "Fixture" },
    "fixture",
  );
  const store = app.conversation("host", {
    newSession: { sessionId: "session", workingDirectory: "~", provider: "replay" },
  })!;
  const container = document.createElement("div");
  const root = createRoot(container);
  afterEachCleanup = () => {
    act(() => root.unmount());
    app.dispose();
  };
  return { app, container, store, root };
}
let afterEachCleanup = () => {};
afterEach(() => {
  afterEachCleanup();
  vi.restoreAllMocks();
});
it("sends an opaque permission option unchanged, and private answers only to the secret API", async () => {
  const { store, root, container } = await fixture();
  const permission = vi.spyOn(store.controller, "answerPermission").mockResolvedValue(true);
  const secret = vi.spyOn(store.controller, "answerSecretRequest").mockResolvedValue(true);
  const publicAnswer = vi.spyOn(store.controller, "answerQuestion");
  const send = vi.spyOn(store.controller, "send");
  const question: PendingQuestion = { kind: "secret", questionId: "private", questions: [] };
  const meta = {
    ...store.metaSnapshotOf(),
    permissions: [
      {
        questionId: "approval",
        description: null,
        toolName: "Run",
        options: [{ id: "acceptWithExecpolicyAmendment", label: "Allow matching commands" }],
      },
    ],
    questions: [question],
  };
  store.controller.model.apply({ type: "question_request", ...question });
  await act(async () => root.render(<>
    <RequestPanels store={store} meta={meta} />
    <ConversationCard store={store} id={`host-question:${question.questionId}`} />
  </>));
  expect(container.querySelectorAll("button")).toHaveLength(2);
  const [approve, submit] = container.querySelectorAll("button");
  await act(async () => approve!.click());
  expect(permission).toHaveBeenCalledWith("approval", "acceptWithExecpolicyAmendment");
  await act(async () => submit!.click());
  expect(secret).toHaveBeenCalledWith("private", ["fixture", null]);
  expect(publicAnswer).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  vi.spyOn(store.controller, "mayApprove", "get").mockReturnValue(false);
  await act(async () => submit!.click());
  expect(secret).toHaveBeenCalledTimes(1);
});

it("keeps failed worktree offers actionable and shows only the outcome after a decision", async () => {
  const { store, root, container } = await fixture();
  const { WorktreeOfferCard } = await vi.importActual<typeof import("@solus-mobile/features/threads/WorktreeOfferCard")>(
    "@solus-mobile/features/threads/WorktreeOfferCard",
  );
  const decide = vi.spyOn(store.controller, "decideWorktreeOffer").mockResolvedValue();
  const offer = { kind: "worktree_offer" as const, id: "activity", offerId: "offer", branch: "new-branch", path: "/project" };
  await act(async () => root.render(<WorktreeOfferCard store={store}
    offer={{ ...offer, resolution: { decision: "failed", error: "Branch is busy" } }} />));
  expect(container.textContent).toContain("Branch is busy");
  await act(async () => container.querySelectorAll("button")[1]!.click());
  expect(decide).toHaveBeenCalledWith("offer", "keep");
  await act(async () => root.render(<WorktreeOfferCard store={store}
    offer={{ ...offer, resolution: { decision: "kept" } }} />));
  expect(container.textContent).toContain("Kept the current checkout");
  expect(container.textContent).toContain("new-branch");
  expect(container.querySelector("button")).toBeNull();
});

it("submits the current keyboard value and the declined secret in request order", async () => {
  const { app, root, container } = await fixture();
  const { PendingSecretCard } = await vi.importActual<typeof import("@solus-mobile/features/threads/PendingSecretCard")>(
    "@solus-mobile/features/threads/PendingSecretCard",
  );
  const request: PendingQuestion = { kind: "secret", questionId: "private", questions: ["First", "Second"].map(header => ({
    header, question: "Private fixture", options: [], multiSelect: false,
  })) };
  const submit = vi.fn(async () => {});
  await act(async () => root.render(<AppProvider app={app}>
    <PendingSecretCard request={request} mayDrive responding={false} onSubmit={submit} />
  </AppProvider>));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Decline First"]')!.click());
  const input = container.querySelector("input")!;
  await act(async () => {
    input.value = "typed fixture";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(submit.mock.calls).toEqual([[[null, "typed fixture"]]]);
  expect(container.querySelector("input")!.value).toBe("");
});

it("uses the T3 approval card and keeps approval feedback from racing a button response", async () => {
  const { store, root, container } = await fixture();
  const permission = {
    questionId: "approval",
    description: null,
    toolName: "Run",
    supportsFeedback: true as const,
    options: [
      { id: "allow-session", label: "Allow for Session", kind: "allow" },
      { id: "deny", label: "Deny", kind: "deny" },
    ],
  };
  const reply = Promise.withResolvers<boolean>();
  const respond = vi.spyOn(store.controller, "answerPermission")
    .mockReturnValueOnce(reply.promise)
    .mockResolvedValueOnce(true);
  const meta = { ...store.metaSnapshotOf(), permissions: [permission] };
  vi.spyOn(store, "metaSnapshotOf").mockReturnValue(meta);

  function ApprovalControls() {
    const { respondToPermission, respondingPermissionId } = useHostApprovalResponses(store);
    const projection = hostApprovalCard(permission)!;
    return (
      <>
        <PendingApprovalCard
          approval={projection.approval}
          canOperateThread
          respondingApprovalId={respondingPermissionId ? projection.approval.requestId : null}
          onRespond={hostApprovalResponder(projection.optionIds, respondToPermission)}
        />
        <button onClick={() => void sendHostApprovalFeedback(permission, "Use a smaller scope.", respondToPermission)}>
          Send feedback
        </button>
      </>
    );
  }

  await act(async () => root.render(<ApprovalControls />));
  const [allow, deny, feedback] = container.querySelectorAll("button");
  await act(async () => allow!.click());
  expect(deny?.disabled).toBe(true);
  await act(async () => feedback!.click());
  expect(respond.mock.calls).toEqual([["approval", "allow-session", undefined]]);
  await act(async () => reply.resolve(false));
  await act(async () => feedback!.click());
  expect(respond).toHaveBeenLastCalledWith("approval", "deny", "Use a smaller scope.");
});
// The Add machine card does its work with host RPCs, then answers like a question: only the outcome goes back.
it("answers the Add machine card with its outcome through the question answer", async () => {
  const { store, root, container } = await fixture();
  const publicAnswer = vi.spyOn(store.controller, "answerQuestion").mockResolvedValue(true);
  const secret = vi.spyOn(store.controller, "answerSecretRequest");
  const send = vi.spyOn(store.controller, "send");
  const question: PendingQuestion = {
    kind: "host-link",
    questionId: "add",
    questions: [],
    hostLink: { reason: "To run the tests there." },
  };
  const meta = { ...store.metaSnapshotOf(), questions: [question] };
  store.controller.model.apply({ type: "question_request", ...question });
  await act(async () => root.render(<>
    <RequestPanels store={store} meta={meta} />
    <ConversationCard store={store} id={`host-question:${question.questionId}`} />
  </>));
  const [add] = container.querySelectorAll("button");
  expect(add!.textContent).toBe("Add machine on host");
  await act(async () => add!.click());
  expect(publicAnswer).toHaveBeenCalledWith("add", { status: "added", installationId: "win", way: "ssh" });
  expect(secret).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
// The machine card only collects choices: they go back as the question's answers, using its transcript row.
it("answers the cloud machine card through the question answer", async () => {
  const { store, root, container } = await fixture();
  const publicAnswer = vi.spyOn(store.controller, "answerQuestion").mockResolvedValue(true);
  const send = vi.spyOn(store.controller, "send");
  const question: PendingQuestion = {
    kind: "cloud-machine",
    questionId: "machine",
    questions: [],
    cloudMachine: { mode: "join", reason: "To share it.", organizations: [{ id: "acme", name: "Acme" }], address: "dev@box" },
  };
  expect(hasOwnCard(question)).toBe(true);
  const meta = { ...store.metaSnapshotOf(), questions: [question] };
  store.controller.model.apply({ type: "question_request", ...question });
  await act(async () => root.render(<>
    <RequestPanels store={store} meta={meta} />
    <ConversationCard store={store} id={`host-question:${question.questionId}`} />
  </>));
  const [card] = container.querySelectorAll("button");
  expect(card!.textContent).toBe("Cloud machine join");
  await act(async () => card!.click());
  expect(publicAnswer).toHaveBeenCalledWith("machine", { status: "chosen", organizationId: "acme" });
  expect(send).not.toHaveBeenCalled();
});
it("keeps MCP input, errors and returned images in the same work-log disclosure", async () => {
  const { store, root, container } = await fixture();
  store.controller.model.items.set("t", {
    kind: "tool",
    id: "t",
    toolId: "tool",
    toolName: "mcp__solus__files__read",
    status: "error",
    input: '{"file_path":"/repo/file.ts"}',
    errorHead: "Permission denied",
    images: [{ assetId: "asset", mimeType: "image/png" }],
    childCount: 0,
    subagent: null,
    report: null,
  });
  const feed = conversationFeed(store, "session", key => <ConversationCard store={store} id={key} />,
    async path => path, async key => key, { provider: "claude-code", child: () => undefined })(["t"]).get();
  expect(feed).toHaveLength(1);
  const group = feed[0];
  if (group?.type !== "activity-group") throw new Error("Expected an MCP work-log row");
  const row = group.activities[0]!;
  expect(row.canExpand).toBe(true);
  expect(row.projectedItem.item).toMatchObject({
    type: "dynamic_tool", input: { file_path: "/repo/file.ts" }, output: "Permission denied", status: "failed",
  });
  await act(async () => root.render(row.renderHostResult?.()));
  expect(container.textContent).toBe("Tool image 1");
});

it("shows the exit code immediately and keeps terminal output behind the disclosure", async () => {
  const { root, container } = await fixture();
  await act(async () => root.render(
    <BackgroundCommandRow command={{
      command: "bun test",
      exitCode: 1,
      attention: true,
      output: "\u001b[31m# 1 failed\u001b[0m\n* End",
    }} />,
  ));
  const row = container.querySelector("button")!;
  expect(row.textContent).toContain("exit 1");
  expect(container.textContent).not.toContain("# 1 failed");
  await act(async () => row.click());
  expect(container.textContent).toContain("# 1 failed\n* End");
  await act(async () => row.click());
  expect(container.textContent).not.toContain("# 1 failed");
});

it.each(["screen", "inspector", "linked host"] as const)("opens an upstream child row with one tap (%s)", async (destination) => {
  vi.clearAllMocks();
  host.inspect.mockReturnValue(destination === "inspector");
  const { store, root, container } = await fixture();
  const { model } = store.controller;
  model.apply({
    type: "agent_conversation_update",
    update: {
      phase: "dispatched", sessionId: "child", messageId: "exchange", origin: "created",
      provider: "claude-code", title: "Review", cwd: "~", model: "claude-fable-5-2",
      ...(destination === "linked host" && { serverId: "remote" }),
      reasoningEffort: "high", prompt: "Review it", dispatchedAt: 1,
    },
  });
  const reader = conversationFeed(store, "session", () => null, async path => path, async key => key,
    { provider: "claude-code", child: remoteAgentChild("host") })(model.order);
  const group = reader.get()[0];
  if (group?.type !== "activity-group") throw new Error("Expected an upstream agent group");
  await act(async () => root.render(<ThreadSubagentGroup activities={group.activities}
    environmentId={EnvironmentId.make("host")} anchorKey={group.id} expandedRows={{}}
    iconSubtleColor="gray" onToggleRow={() => { throw new Error("Single child expanded"); }} />));
  const row = container.querySelector("button")!;
  expect(row.textContent).toContain("Review");
  await act(async () => row.click());
  if (destination === "linked host") {
    expect(host.dispatch).toHaveBeenCalledWith({
      name: "LinkedThread",
      params: { environmentId: "remote", threadId: "child", viaEnvironmentId: "host",
        parentSessionId: "session", label: "Host", title: "Review" },
    });
  } else if (destination === "inspector") {
    expect(host.inspect).toHaveBeenCalledWith(
      { environmentId: "host", threadId: "session" },
      { type: "thread", environmentId: "host", threadId: "child" },
    );
    expect(host.dispatch).not.toHaveBeenCalled();
  } else {
    expect(host.dispatch).toHaveBeenCalledWith({
      name: "Thread", params: { environmentId: "host", threadId: "child" },
    });
  }
});
it("expands an upstream group to one row per provider agent and collapses it again", async () => {
  const { store, root, container } = await fixture();
  const { model } = store.controller;
  for (const [index, description] of ["Read policy", "Check clients"].entries()) {
    const toolId = "call-" + index;
    model.apply({ type: "tool_call", toolName: "Agent", toolId, index, isSubagent: true });
    model.apply({ type: "tool_call_complete", toolId, index, toolInput: JSON.stringify({ description }) });
  }
  const reader = conversationFeed(store, "session", () => null, async path => path, async key => key,
    { provider: "claude-code", child: remoteAgentChild("host") })(model.order);
  const group = reader.get()[0];
  if (group?.type !== "activity-group") throw new Error("Expected a subagent group");
  const renderGroup = (expanded: boolean) => root.render(<ThreadSubagentGroup
    activities={group.activities} environmentId={EnvironmentId.make("host")}
    anchorKey={group.id} expandedRows={{ [group.id]: expanded }}
    iconSubtleColor="gray" onToggleRow={() => renderGroup(!expanded)} />);
  await act(async () => renderGroup(false));
  const header = container.querySelector("button")!;
  expect(container.textContent).not.toContain("Read policy");
  await act(async () => header.click());
  expect(container.textContent).toContain("Read policy");
  expect(container.textContent).toContain("Check clients");
  const agent = Array.from(container.querySelectorAll("button")).find(row => row.textContent?.includes("Check clients"))!;
  await act(async () => agent.click());
  expect(host.navigate).toHaveBeenCalledWith("ProviderAgentTranscript", {
    environmentId: "host", threadId: "session", toolId: "call-1", title: "Check clients",
  });
  expect(agent.textContent).toContain("Claude");
  expect(agent.textContent).not.toContain("Not reported");
  await act(async () => header.click());
  expect(container.textContent).not.toContain("Check clients");
});
it("routes a child plan approval to the child instead of accepting the parent plan", async () => {
  const { store, container, root } = await fixture();
  const plan = {
    targetSessionId: "child",
    messageId: "exchange",
    sessionTitle: "Child session",
    planTitle: "Proposed plan",
    content: "Steps",
  };
  const decide = vi.spyOn(store.controller, "decideAgentPlan").mockResolvedValue(true);
  const acceptParent = vi.spyOn(store.controller, "approvePlan");
  await act(async () =>
    root.render(
      <RequestPanels store={store} meta={{ ...store.metaSnapshotOf(), agentPlans: [plan] }} />,
    ),
  );
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Approve")!
      .click(),
  );
  expect(decide).toHaveBeenCalledWith(plan, "approve", "");
  expect(acceptParent).not.toHaveBeenCalled();
});

const textStyle = {
    color: "",
    strongColor: "",
    mutedColor: "",
    linkColor: "",
    inlineCodeColor: "",
    codeColor: "",
    codeBackgroundColor: "",
    codeBlockBackgroundColor: "",
    fileTextColor: "",
    quoteMarkerColor: "",
    dividerColor: "",
    fontSize: 14,
    lineHeight: 18,
    fontFamily: "",
    headingFontFamily: "",
    boldFontFamily: "",
  };

it("opens a closed assistant HTML fence in T3's themed WebView and keeps Markdown links on either side", async () => {
  const { root, container } = await fixture();
  const html = "<title>Traffic</title><button>Refresh</button>";
  const opening = "[More][doc]\n\n```html render\n" + html;
  const show = async (markdown: string, renderHtml = true) =>
    act(async () =>
      root.render(
        <AssistantReplyMarkdown
          markdown={markdown}
          renderHtml={renderHtml}
          definitions={[]}
          textStyle={textStyle}
        />,
      ),
    );
  await show(opening);
  expect(container.querySelector("[data-page]")).toBeNull();
  const complete = opening + "\n```\n\nAfter\n\n[doc]: https://example.org";
  await show(complete);
  const page = container.querySelector("[data-page]")!;
  expect(page.getAttribute("data-page")).toContain('<style id="t3-theme">');
  expect(page.getAttribute("data-page")).toContain(html);
  expect(page.getAttribute("aria-label")).toBe("Traffic");
  expect(container.firstElementChild?.textContent).toContain("[doc]: https://example.org");
  expect(container.lastElementChild?.textContent).toContain("After");
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("section [data-page]")?.getAttribute("data-page")).toBe(
    page.getAttribute("data-page"),
  );
  await act(async () => container.querySelector<HTMLButtonElement>("section button")!.click());
  expect(container.querySelector("section")).toBeNull();
  await show(complete.replace("html render", "html source"));
  expect(container.querySelector("[data-page]")).toBeNull();
  await show(complete, false);
  expect(container.querySelector("[data-page]")).toBeNull();
});

it("opens a session guide stop inline with the host patch for its numbered turn", async () => {
  const { root, container } = await fixture();
  const patch = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
  const read = vi.fn(async () => ({ patch }));
  const guide = { title: "Session guide", summary: "Two edits.", sections: [
    { title: "Latest edit", significance: "core", explanation: "Check the new value.", files: [{turn: 2, path: "file"}] },
  ] };
  await act(async () => root.render(
    <TurnDiffReader.Provider value={read}>
      <AssistantReplyMarkdown markdown={"```review-guide\n" + JSON.stringify(guide) + "\n```"}
        renderHtml definitions={[]} textStyle={textStyle} />
    </TurnDiffReader.Provider>,
  ));
  await vi.waitFor(() => expect(container.textContent).toContain("Open stop"));
  expect(read).toHaveBeenCalledWith(1);
  const click = (label: string) => act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  await click("Open stop");
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Open "]')!.click());
  expect(container.querySelector("section pre")?.textContent).toBe(patch);
  await act(async () => container.querySelector<HTMLButtonElement>('section button[aria-label^="Close "]')!.click());
  expect(read).toHaveBeenCalledTimes(1);
  expect(container.querySelector("pre")?.textContent).toBe(patch);
  expect(container.textContent).toContain("Check the new value.");
});

it("shows the upstream setup stages until the agent starts and keeps host recovery in Details", async () => {
  const { store, root, container } = await fixture();
  const threadId = ThreadId.make("session");
  const card = pendingWorktreeSetupCard(threadId, "main");
  const active = sessionWorktreeSetup(store, threadId, card, 1000, true);
  expect(active?.snapshot.stages.map(stage => [stage.id, stage.status])).toEqual([
    ["fetch", "running"], ["checkout", "pending"], ["submodules", "pending"], ["agent", "pending"],
  ]);
  expect(active?.onWorkLocally).toBeTypeOf("function");
  expect(sessionWorktreeSetup(store, threadId, settleSetupCard(card, "running"), 1000, true)).toBeNull();
  const failed = { ...settleSetupCard(card, "failed"), recovery: "worktree" as const, output: ["Checkout failed"] };
  failed.steps[0]!.substeps = [{ id: "repo", label: "Mobile repo", status: "error", detail: "Fetch failed" }];
  const recover = vi.spyOn(store.controller, "recoverWorktreeSetup").mockResolvedValue();
  const props = sessionWorktreeSetup(store, threadId, failed, 1000, true);
  expect(props?.snapshot.phase).toBe("failed");
  await act(async () => root.render(props?.extraDetails));
  expect(container.textContent).toContain("Checkout failed");
  expect(container.textContent).toContain("Mobile repo · error · Fetch failed");
  const [retry, local] = container.querySelectorAll("button");
  await act(async () => retry!.click());
  await act(async () => local!.click());
  expect(recover.mock.calls).toEqual([["setup:worktree-session", false], ["setup:worktree-session", true]]);
  const readOnly = sessionWorktreeSetup(store, threadId, failed, 1000, false);
  await act(async () => root.render(readOnly?.extraDetails));
  expect(container.querySelector("button")).toBeNull();
  expect(readOnly?.onCancel).toBeNull();
});
