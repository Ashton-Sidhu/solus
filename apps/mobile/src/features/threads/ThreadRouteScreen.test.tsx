import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type SessionKind = "ready" | "loading" | "unavailable";

const state = vi.hoisted(() => ({
  draft: true,
  sessionKind: "ready" as SessionKind,
  navigate: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
  StackActions: {},
}));
vi.mock("react-native", () => ({ View: ({ children }: { children: ReactNode }) => children }));
vi.mock("@solus-mobile/app/app-context", () => ({
  AppProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../solus/runtime", () => ({ solus: {} }));
vi.mock("../../solus/use-thread-session", () => ({
  useThreadSession: () =>
    state.sessionKind === "ready"
      ? {
          kind: "ready",
          hostId: "host",
          id: "session",
          store: { controller: {} },
        }
      : { kind: state.sessionKind, hostId: "host" },
}));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: () => () => {},
  useWorkspaceBackNavigation: () => () => {},
}));
vi.mock("../../solus/use-thread-screen-data", () => ({
  useThreadScreenData: () => ({
    binding: {},
    draft: state.draft ? { title: "project" } : null,
    header: { title: "Thread", projectName: "project", cwd: "/repo/worktree", draft: state.draft },
  }),
}));
vi.mock("../../solus/DraftWorkspaceControls", () => ({ DraftWorkspaceControls: () => null }));
vi.mock("../../solus/CheckoutGit", () => ({
  useCheckoutGitControls: () => ({ environmentId: "host", threadId: "session" }),
}));
vi.mock("./ThreadHeader", () => ({
  ThreadHeader: ({ onOpenFilesInspector }: { onOpenFilesInspector: () => void }) => (
    <button onClick={onOpenFilesInspector}>Files</button>
  ),
  ThreadNavigationHeader: () => null,
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { variant: "expanded" } }),
  Inspector: ({ content }: { content: { panes: { render: () => ReactNode }[] } }) =>
    content.panes[0]?.render(),
}));
vi.mock("./ThreadDetailScreen", () => ({
  ThreadDetailScreen: ({
    draftMode,
    layoutVariant,
  }: {
    draftMode?: object;
    layoutVariant: string;
  }) => <input data-state={draftMode ? "draft" : "live"} data-layout={layoutVariant} />,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./thread-inspector-preview", () => ({
  InspectorContentScope: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./thread-inspector-header", () => ({
  ThreadInspectorHeader: ({ onClose }: { onClose: () => void }) => (
    <button onClick={onClose}>Close thread</button>
  ),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: () => <button>Back to list</button>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/EmptyState", () => ({
  EmptyState: ({ title }: { title: string }) => <span>{title}</span>,
}));
vi.mock("../../components/LoadingScreen", () => ({
  LoadingScreen: ({ message }: { message: string }) => <span>{message}</span>,
}));
vi.mock("./NewTaskHero", () => ({
  draftHeroContent: () => () => null,
  SHORT_DRAFT_VIEWPORT_HEIGHT: 380,
}));
vi.mock("./DraftEnvironmentControl", () => ({ DraftEnvironmentControl: () => null }));

import { ThreadRouteScreen } from "./ThreadRouteScreen";

it("keeps the same editor when the draft becomes a thread and opens its files on the same host", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    act(() =>
      root.render(
        <ThreadRouteScreen
          route={{
            params: state.draft
              ? { draft: { environmentId: "host", projectId: "/repo" } }
              : { environmentId: "host", threadId: "session" },
          }}
          renderInspector={() => <span>File navigator</span>}
        />,
      ),
    );
  try {
    render();
    const input = container.querySelector("input");
    expect(input?.dataset.state).toBe("draft");
    expect(input?.dataset.layout).toBe("expanded");
    expect(container.textContent).toContain("File navigator");
    act(() => container.querySelector("button")!.click());
    expect(state.navigate).toHaveBeenLastCalledWith("NewTaskFiles", {
      environmentId: "host",
      cwd: "/repo/worktree",
      projectName: "project",
    });

    state.draft = false;
    render();
    expect(container.querySelector("input")).toBe(input);
    expect(input?.dataset.state).toBe("live");
    act(() => container.querySelector("button")!.click());
    expect(state.navigate).toHaveBeenLastCalledWith("ThreadFiles", {
      environmentId: "host",
      threadId: "session",
      cwd: "/repo/worktree",
      projectName: "project",
    });
  } finally {
    act(() => root.unmount());
    state.draft = true;
  }
});

it("keeps the inspector close control while a thread loads or is unavailable", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onClose = vi.fn();
  const render = (sessionKind: SessionKind) => {
    state.sessionKind = sessionKind;
    act(() =>
      root.render(
        <ThreadRouteScreen
          route={{ params: { environmentId: "host", threadId: "session" } }}
          inspectorPresentation={{ onClose }}
        />,
      ),
    );
  };
  try {
    render("loading");
    expect(container.textContent).toContain("Opening thread");
    expect(container.querySelector("button")?.textContent).toBe("Close thread");
    render("unavailable");
    expect(container.textContent).toContain("Thread unavailable");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Close thread",
    ]);
    act(() => container.querySelector("button")!.click());
    expect(onClose).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    state.sessionKind = "ready";
  }
});
