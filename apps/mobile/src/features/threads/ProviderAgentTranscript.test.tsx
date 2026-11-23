import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { SessionHistoryPage, SessionSubagentRequest } from "@solus/contracts/session-history";
import { expect, it, vi } from "vite-plus/test";
import type { ReadOnlyThreadHistory } from "./LinkedThreadSheet";
import { ProviderAgentTranscript } from "./ProviderAgentTranscript";

const host = vi.hoisted(() => ({
  scope: "first",
  connection: {
    api: {
      loadSessionSubagent: vi.fn<(q: SessionSubagentRequest) => Promise<SessionHistoryPage>>(),
    },
  },
  controller: {
    historySource: { sessionId: "parent", provider: "claude-code", projectPath: "/repo" },
  },
}));
vi.mock("../../solus/use-session-controller", () => ({
  useSessionController: () => host.controller,
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
    </>
  ),
}));

it("reads the tapped call, pages its history and drops a late page after a scope change", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const page = (content: string, before: string | null): SessionHistoryPage => ({
    messages: [{ role: "assistant", content, timestamp: 100 }],
    before,
  });
  let finish!: (page: SessionHistoryPage) => void;
  host.connection.api.loadSessionSubagent
    .mockResolvedValueOnce(page("First account", "cursor"))
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
