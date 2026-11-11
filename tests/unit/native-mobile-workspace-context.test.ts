// The workspace context is split so a sidebar toggle re-renders only the
// screens that show which panes are open. A screen that holds only a command
// (a sidebar button, a header) must keep its render when the sidebar toggles,
// and the command it holds must keep its identity. This drives the real
// AdaptiveWorkspaceLayout in its iPad native-columns mode through React DOM;
// it is not proof of React Native's renders on a device.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";

// react-dom carries its own React; the component under test must share the
// renderer's copy, so `react` is that copy.
const requireFromReactDom = createRequire(createRequire(import.meta.url).resolve("react-dom/package.json"));
const React = requireFromReactDom("react") as typeof import("react");
mock.module("react", () => React);
const { createElement } = React;

const mobile = "../../apps/mobile/src";
const noop = () => undefined;
const passThrough = (props: { readonly children?: ReactNode }) => props.children ?? null;

mock.module("react-native", () => ({
  Platform: { OS: "ios", select: (options: { readonly ios?: unknown }) => options.ios },
  useWindowDimensions: () => ({ width: 1366, height: 1024 }),
  View: passThrough,
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
mock.module("react-native-reanimated", () => ({
  default: { View: passThrough },
  useAnimatedStyle: () => ({}),
  useDerivedValue: () => ({ value: 0 }),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));
mock.module("@react-navigation/native", () => ({
  CommonActions: { reset: noop },
  StackActions: { replace: noop },
  useNavigation: () => ({ navigate: noop, dispatch: noop, getState: () => ({ routes: [], index: 0 }) }),
}));
mock.module(`${mobile}/features/keyboard/use-keyboard-command`, () => ({ useKeyboardCommand: noop }));
mock.module(`${mobile}/features/home/home-list-options`, () => ({ HomeListOptionsProvider: passThrough }));
mock.module(`${mobile}/features/threads/thread-directory`, () => ({
  threadKey: (hostId: string, sessionId: string) => `${hostId}\u0000${sessionId}`,
}));
mock.module(`${mobile}/features/threads/ThreadNavigationSidebar`, () => ({ ThreadNavigationSidebar: passThrough }));
mock.module(`${mobile}/features/threads/use-thread-list`, () => ({
  useSharedWithYouNotices: noop,
  useThreadListRefresh: noop,
}));
mock.module(`${mobile}/features/live-activity/use-agent-live-activity`, () => ({ useAgentLiveActivity: noop }));
mock.module(`${mobile}/features/workspace/AndroidWorkspaceNavigation`, () => ({
  ANDROID_WORKSPACE_RAIL_WIDTH: 72,
  AndroidWorkspaceRail: passThrough,
}));
mock.module(`${mobile}/components/RenderErrorBoundary`, () => ({
  RenderErrorBoundary: passThrough,
  RenderFailureView: passThrough,
}));
mock.module(`${mobile}/features/layout/workspace-pane-animation`, () => ({ WORKSPACE_PANE_TIMING: {} }));
mock.module(`${mobile}/features/layout/workspace-inspector-pane`, () => ({ WorkspaceInspectorPane: passThrough }));

const { AdaptiveWorkspaceLayout, useAdaptiveWorkspaceLayout, useWorkspacePaneState } = await import(
  `${mobile}/features/layout/AdaptiveWorkspaceLayout`
);
const { NativeWorkspaceModeContext } = await import(`${mobile}/native/v5-workspace-context`);

const dom = new JSDOM("<!doctype html><div id=root></div>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = requireFromReactDom("react-dom/client") as typeof import("react-dom/client");
const act = React.act;

let root: ReturnType<typeof createRoot>;
let commandReaderRenders = 0;
let toggles: Array<() => void> = [];
let sidebarStates: boolean[] = [];

/** A sidebar button: it holds the toggle command and nothing that a toggle changes. */
function SidebarButton() {
  const { togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  commandReaderRenders += 1;
  toggles.push(togglePrimarySidebar);
  return null;
}

/** A header that shows whether the sidebar is open. */
function SidebarState() {
  const { panes } = useWorkspacePaneState();
  sidebarStates.push(panes.primarySidebarVisible);
  return null;
}

beforeEach(async () => {
  commandReaderRenders = 0;
  toggles = [];
  sidebarStates = [];
  root = createRoot(document.getElementById("root")!);
  const location = {
    routeName: "Thread",
    routeKey: "thread-1",
    thread: { hostId: "host-1", sessionId: "session-1" },
    settingsOpen: false,
  };
  await act(async () => {
    root.render(
      createElement(
        NativeWorkspaceModeContext.Provider,
        { value: true },
        createElement(AdaptiveWorkspaceLayout, { location }, createElement(SidebarButton), createElement(SidebarState)),
      ),
    );
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("adaptive workspace context", () => {
  test("a sidebar toggle re-renders pane readers but not a reader that holds only a command", async () => {
    expect(sidebarStates).toEqual([true]);
    expect(commandReaderRenders).toBe(1);

    await act(async () => toggles[0]!());
    await act(async () => toggles[0]!());

    expect(sidebarStates).toEqual([true, false, true]);
    expect(commandReaderRenders).toBe(1);
  });

  test("the held command keeps working after the panes change", async () => {
    const toggle = toggles[0]!;
    await act(async () => toggle());
    // The first render's command closes over the old panes; it must still run the latest handler.
    await act(async () => toggle());
    await act(async () => toggle());
    expect(sidebarStates).toEqual([true, false, true, false]);
  });
});
