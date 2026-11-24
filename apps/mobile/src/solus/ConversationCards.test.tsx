import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SolusApp } from "@solus-mobile/app/solus-app";
import { memoryKeyValueStore, memorySecretStore } from "@solus-mobile/platform/ports";
import type { PendingQuestion } from "@solus-mobile/features/conversation/lib/pending-requests";
import { WsTransport } from "@solus/client-core/ws-transport";
import { RequestPanels } from "./RequestCards";
import { TurnDiffReader } from "./turn-diff-context";
import { AssistantReplyMarkdown } from "./AssistantReplyMarkdown";
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
  inspect: vi.fn(() => false),
  dispatch: vi.fn(),
  remember: vi.fn(),
  read: vi.fn(async (id: string) => ({ sessionId: id })),
  recordOpen: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: host.dispatch, getState: () => undefined }),
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
  Pressable: ({ onPress, children, accessibilityLabel }: { onPress: () => void; children: ReactNode; accessibilityLabel?: string }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button>
  ),
  Alert: { alert: vi.fn() },
  useWindowDimensions: () => ({ height: 800, width: 360 }),
}));
vi.mock("../components/ui/AppText", () => ({
  AppTextInput: () => <input />,
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
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
    threads: { thread: () => null, managedHostIds: () => new Set(), rememberSearchResult: host.remember },
    connections: { state: () => undefined, connection: () => ({ api: { sessionRecordGet: host.read } }) },
    registry: { host: () => ({ label: "Host" }) },
    history: { record: host.recordOpen },
    // A started session's card reads its agent activity from the thread list.
    threadList: { changes: { subscribe: () => () => {} }, facts: () => ({ agentActivity: new Map() }) },
  },
}));
// The dots read app state and screen focus; these tests are about what a card opens.
vi.mock("../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
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
  return { container, store, root };
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
  await act(async () => root.render(<RequestPanels store={store} meta={meta} />));
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
  await act(async () => root.render(<RequestPanels store={store} meta={meta} />));
  const [add] = container.querySelectorAll("button");
  expect(add!.textContent).toBe("Add machine on host");
  await act(async () => add!.click());
  expect(publicAnswer).toHaveBeenCalledWith("add", { status: "added", installationId: "win", way: "ssh" });
  expect(secret).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
it("expands the actual tool row to show host input, the error and returned images", async () => {
  const { store, root, container } = await fixture();
  store.controller.model.items.set("t", {
    kind: "tool",
    id: "t",
    toolId: "tool",
    toolName: "Read",
    status: "error",
    input: '{"file_path":"/repo/file.ts"}',
    errorHead: "Permission denied",
    images: [{ assetId: "asset", mimeType: "image/png" }],
    childCount: 0,
    subagent: null,
    report: null,
  });
  await act(async () => root.render(<ConversationCard store={store} id="t" />));
  expect(container.textContent).not.toContain("Permission denied");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Permission denied");
  expect(container.textContent).toContain("/repo/file.ts");
  expect(container.textContent).toContain("Tool image 1");
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).not.toContain("Tool image 1");
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

it.each(["screen", "inspector", "linked host"] as const)("opens a child with one tap (%s)", async (destination) => {
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
  model.apply({
    type: "agent_conversation_update",
    update: {
      phase: "settled", sessionId: "child", messageId: "exchange", status: "completed",
      replyText: "Reviewed", settledAt: 2,
    },
  });
  await act(async () => root.render(<ConversationCard store={store} id={model.agentRows[0]!.id} />));
  expect(container.textContent).toContain("Claude Code · Fable 5.2 · High");
  await act(async () => container.querySelector("button")!.click());
  if (destination === "linked host") {
    expect(host.dispatch).toHaveBeenCalledWith({
      name: "LinkedThread",
      params: { environmentId: "remote", threadId: "child", viaEnvironmentId: "host", label: "Host", title: "Review" },
    });
    expect(host.read).not.toHaveBeenCalled();
    return;
  }
  expect(host.inspect).toHaveBeenCalledWith(
    { environmentId: "host", threadId: "session" },
    { type: "thread", environmentId: "host", threadId: "child" },
  );
  expect(host.read).toHaveBeenCalledWith("child");
  expect(host.remember).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: "host", record: { sessionId: "child" } }),
  );
  if (destination === "inspector") {
    expect(host.dispatch).not.toHaveBeenCalled();
    return;
  }
  expect(host.dispatch).toHaveBeenCalledWith({
    name: "Thread",
    params: { environmentId: "host", threadId: "child" },
  });
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

it("opens an earlier saved artifact in the same T3 renderer on demand", async () => {
  const { store, root, container } = await fixture();
  store.controller.model.items.set("page", {
    kind: "artifact",
    id: "page",
    title: "Snapshot",
    html: "<p>Version one</p>",
    workId: "work",
  });
  await act(async () => root.render(<ConversationCard store={store} id="page" superseded />));
  expect(container.querySelector("[data-page]")).toBeNull();
  await act(async () => container.querySelector("button")!.click());
  const html = container.querySelector("[data-page]")?.getAttribute("data-page");
  expect(html).toContain('<style id="t3-theme">');
  expect(html).toContain("<p>Version one</p>");
});

it("puts a saved artifact the person opens full screen into their history", async () => {
  const { store, root, container } = await fixture();
  store.controller.model.items.set("page", {
    kind: "artifact",
    id: "page",
    title: "Snapshot",
    html: "<p>Version one</p>",
    workId: "work",
  });
  await act(async () => root.render(<ConversationCard store={store} id="page" />));
  // Shown in the conversation is not opened.
  expect(host.recordOpen).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open Snapshot"]')!.click());
  expect(host.recordOpen).toHaveBeenCalledWith("work:work");
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
