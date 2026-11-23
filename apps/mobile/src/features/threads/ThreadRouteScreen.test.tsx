import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ draft: true, navigate: vi.fn() }));
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
  useThreadSession: () => ({
    kind: "ready",
    hostId: "host",
    id: "session",
    store: { controller: {} },
  }),
}));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: () => () => {},
}));
vi.mock("../../solus/use-thread-screen-data", () => ({
  useThreadScreenData: () => ({
    binding: {},
    draft: state.draft ? { title: "project" } : null,
    header: { title: "Thread", projectName: "project", cwd: "/repo/worktree", draft: state.draft },
  }),
}));
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
vi.mock("./thread-inspector-header", () => ({ ThreadInspectorHeader: () => null }));
vi.mock("./ThreadRouteStateScreens", () => ({
  OpeningThreadLoadingScreen: () => null,
  ThreadUnavailableScreen: () => null,
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
  }
});
