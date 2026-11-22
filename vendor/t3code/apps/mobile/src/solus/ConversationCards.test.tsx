import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { SolusApp } from "@solus-mobile/app/solus-app";
import { memoryKeyValueStore, memorySecretStore } from "@solus-mobile/platform/ports";
import type {
  PendingPermission,
  PendingQuestion,
} from "@solus-mobile/features/conversation/lib/pending-requests";
import { WsTransport } from "@solus/client-core/ws-transport";
import { RequestCards } from "./RequestCards";
import { AssistantReplyMarkdown } from "./AssistantReplyMarkdown";
import { ConversationCard } from "./ConversationCard";

const host = vi.hoisted(() => ({
  dispatch: vi.fn(),
  remember: vi.fn(),
  read: vi.fn(async (id: string) => ({ sessionId: id })),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: host.dispatch }),
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
  Pressable: ({ onPress, children }: { onPress: () => void; children: ReactNode }) => (
    <button onClick={onPress}>{children}</button>
  ),
  Alert: { alert: vi.fn() },
  useWindowDimensions: () => ({ height: 800, width: 360 }),
}));
vi.mock("../components/ui/AppText", () => ({
  AppTextInput: () => <input />,
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: () => false }));
vi.mock("./runtime", () => ({
  solus: {
    threads: { thread: () => null, rememberSearchResult: host.remember },
    connections: { connection: () => ({ api: { sessionRecordGet: host.read } }) },
    registry: { host: () => ({ label: "Host" }) },
  },
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
vi.mock("@solus-mobile/features/threads/PendingApprovalCard", () => ({
  PendingApprovalCard: ({
    approval,
    onRespond,
  }: {
    approval: PendingPermission;
    onRespond: (id: string, option: string) => void;
  }) => (
    <button onClick={() => onRespond(approval.questionId, approval.options[0]!.id)}>
      Answer permission
    </button>
  ),
}));
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
  await act(async () => root.render(<RequestCards store={store} meta={meta} />));
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

it("opens an unlisted child by its durable session id on the host that owns the parent", async () => {
  const { store, root, container } = await fixture();
  store.controller.model.items.set("agent", {
    kind: "agent",
    id: "agent",
    sessionId: "child",
    provider: "codex",
    title: "Review",
    model: null,
    prompt: "Review it",
    reply: "Reviewed",
    exchanges: [],
    startedAt: 1,
    settledAt: 2,
    durationMs: 1,
  });
  await act(async () => root.render(<ConversationCard store={store} id="agent" />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Reviewed");
  await act(async () => container.querySelectorAll("button")[1]!.click());
  expect(host.read).toHaveBeenCalledWith("child");
  expect(host.remember).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: "host", record: { sessionId: "child" } }),
  );
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
      <RequestCards store={store} meta={{ ...store.metaSnapshotOf(), agentPlans: [plan] }} />,
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

it("opens a closed assistant HTML fence in T3's themed WebView and keeps Markdown links on either side", async () => {
  const { root, container } = await fixture();
  const html = "<title>Traffic</title><button>Refresh</button>";
  const opening = "[More][doc]\n\n```html render\n" + html;
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
