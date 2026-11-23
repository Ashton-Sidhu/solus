import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { AppBarProps } from "../../components/ui/AppBar.types";
import { ThreadHeader } from "./ThreadHeader";

const openFiles = vi.fn();
const terminalMenu = vi.hoisted(() => vi.fn(() => ({ title: "Terminal" })));
vi.mock("./ThreadGitControls", () => ({
  threadTerminalMenu: terminalMenu,
  useThreadGitMenuDefinition: () => ({ title: "Git controls" }),
}));
vi.mock("gt-react-native", () => ({
  useGT: () => (s: string) => s,
  useMessages: () => (s: string) => s,
}));
vi.mock("../layout/workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => vi.fn(),
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({}),
  useWorkspacePaneState: () => ({ panes: { auxiliaryPaneVisible: false } }),
}));
vi.mock("../../components/ui/AppBar", () => ({
  AppBar: (props: AppBarProps) => (
    <div>
      {props.actions?.map((action) => (
        <button key={action.accessibilityLabel} onClick={action.onPress}>
          {action.accessibilityLabel}
        </button>
      ))}
      {props.menus?.map((menu) => (
        <span key={menu.title}>{menu.title}</span>
      ))}
    </div>
  ),
}));

it("opens files and shows Git for a checkout without terminal controls", () => {
  const props: ComponentProps<typeof ThreadHeader> = {
    title: "Session",
    subtitle: "",
    hasThreadCwd: true,
    inspectorMode: null,
    onOpenFilesInspector: openFiles,
    gitControls: {
      environmentId: "host",
      threadId: "session",
      canOpenFiles: true,
      currentBranch: "main",
      gitStatus: null,
      gitOperationLabel: null,
      onPull: async () => {},
      onRunAction: async () => null,
    },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    for (const draft of [true, false]) {
      act(() => root.render(<ThreadHeader {...props} draft={draft} />));
      expect(container.textContent).toBe("Open filesGit controls");
      container.querySelector("button")!.click();
    }
    expect(openFiles).toHaveBeenCalledTimes(2);
    expect(terminalMenu).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
