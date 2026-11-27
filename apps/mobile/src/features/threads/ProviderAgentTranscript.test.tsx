import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SessionHistoryPage, SessionSubagentRequest } from "@solus/contracts/session-history";
import { expect, it, vi } from "vite-plus/test";
import type { ReadOnlyThreadHistory } from "./LinkedThreadSheet";
import { TranscriptModel } from "@solus-mobile/features/conversation/lib/transcript-model";
import { ProviderAgentTranscript } from "./ProviderAgentTranscript";

const host = vi.hoisted(() => ({
  scope: "first",
  connection: {
    api: {
      loadSessionSubagent: vi.fn<(q: SessionSubagentRequest) => Promise<SessionHistoryPage>>(),
    },
  },
  listeners: new Set<() => void>(),
  controller: {
    run: { provider: "claude-code" },
    historySource: { sessionId: "parent", provider: "claude-code", projectPath: "/repo" },
    // SAFETY: The mock installs a transcript model before each screen uses it.
    model: null as TranscriptModel | null,
  },
}));
vi.mock("../../solus/agent-child-host", () => ({ remoteAgentChild: () => () => undefined }));
vi.mock("../../solus/use-session-controller", () => ({
  useSessionStore: () => ({
    controller: host.controller,
    order: { subscribe: () => () => {} },
    item: (id: string) => host.controller.model?.items.get(id),
    subscribeFeedItems: (listener: () => void) => {
      host.listeners.add(listener);
      return () => host.listeners.delete(listener);
    },
  }),
}));
vi.mock("../../state/host-query-scope", () => ({ hostQueryScopeAtom: () => host.scope }));
vi.mock("../../state/mobile-host", () => ({ mobileHost: () => host.connection }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("react-native", () => ({ View: ({ children }: { children: ReactNode }) => children }));
vi.mock("gt-react-native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("gt-react-native")>()),
  useGT: () => (text: string) => text,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("./LinkedThreadSheet", () => ({
  ReadOnlyThreadHistory: ({ view }: Parameters<typeof ReadOnlyThreadHistory>[0]) => (
    <>
      {view.feed.map((row) => (row.type === "message" ? row.message.text : ""))}
      {view.hasOlder && <button onClick={view.loadEarlier}>Earlier</button>}
      {view.historyFailed && <span role="alert">Earlier page failed</span>}
    </>
  ),
}));

host.controller.model = new TranscriptModel("parent");

it("retries a failed page and drops a late page after a scope change", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const page = (content: string, before: string | null): SessionHistoryPage => ({
    messages: [{ role: "assistant", content, timestamp: 100 }],
    before,
  });
  let finish!: (page: SessionHistoryPage) => void;
  host.connection.api.loadSessionSubagent
    .mockResolvedValueOnce(page("First account", "cursor"))
    .mockRejectedValueOnce(new Error("The connection dropped."))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(page("Second account", null));
  const dom = document.createElement("div");
  const root = createRoot(dom);
  const render = () =>
    act(async () =>
      root.render(
        <ProviderAgentTranscript
          route={{
            params: {
              environmentId: EnvironmentId.make("host"),
              threadId: ThreadId.make("parent"),
              toolId: "provider-call",
              title: "Reader",
            },
          }}
        />,
      ),
    );
  try {
    await render();
    expect(dom.textContent).toContain("First account");
    await act(async () => dom.querySelector("button")!.click());
    expect(dom.querySelector('[role="alert"]')?.textContent).toBe("Earlier page failed");
    expect(dom.textContent).toContain("First account");
    await act(async () => dom.querySelector("button")!.click());
    expect(dom.querySelector('[role="alert"]')).toBeNull();
    expect(host.connection.api.loadSessionSubagent).toHaveBeenLastCalledWith({
      sessionId: "parent",
      toolId: "provider-call",
      projectPath: "/repo",
      provider: "claude-code",
      before: "cursor",
    });
    host.scope = "second";
    await render();
    await act(async () => finish(page("Old account earlier page", null)));
    expect(dom.textContent).toBe("Second account");
  } finally {
    act(() => root.unmount());
  }
});


it("shows live replies in the existing child transcript view before history is saved", async () => {
  const model = new TranscriptModel("parent");
  model.apply({ type: "tool_call", toolName: "Agent", toolId: "provider-call", index: 0, isSubagent: true });
  host.controller.model = model;
  host.connection.api.loadSessionSubagent.mockRejectedValueOnce(new Error("The child is still running."));
  const dom = document.createElement("div");
  const root = createRoot(dom);
  try {
    await act(async () => root.render(<ProviderAgentTranscript route={{ params: {
      environmentId: EnvironmentId.make("host"),
      threadId: ThreadId.make("parent"),
      toolId: "provider-call",
      title: "Reader",
    } }} />));
    await act(async () => {
      model.apply({ type: "assistant_message", text: "A reply from the child", parentToolUseId: "provider-call" });
      for (const notify of host.listeners) notify();
    });
    expect(dom.textContent).toContain("A reply from the child");
  } finally {
    act(() => root.unmount());
  }
});
