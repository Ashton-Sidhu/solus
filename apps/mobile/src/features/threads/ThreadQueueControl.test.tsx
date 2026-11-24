import type { SessionQueueSnapshot } from "@solus/contracts/session-queue";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Slot, alert, changeQueue } = vi.hoisted(() => ({
  Slot: ({ children }: { children?: ReactNode }) => children,
  alert: vi.fn(),
  changeQueue: vi.fn(async () => {}),
}));

vi.mock("react-native", () => ({
  View: Slot,
  ScrollView: Slot,
  Pressable: ({
    accessibilityLabel,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel: string;
    children: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-gesture-handler", () => ({ GestureHandlerRootView: Slot }));
vi.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({
  default: ({
    children,
    renderRightActions,
  }: {
    children: ReactNode;
    renderRightActions: () => ReactNode;
  }) => <>{children}{renderRightActions()}</>,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("expo-haptics", () => ({ selectionAsync: async () => {} }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Slot }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Button", () => ({ Button: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert }));
vi.mock("../../components/ui/FilePreviewModal", () => ({ FilePreviewModal: () => null }));
vi.mock("../../components/ui/Menu", () => ({ Menu: Slot }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: Slot }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../solus/ConversationMedia", () => ({ resolveConversationImage: vi.fn() }));
vi.mock("../../state/assets", () => ({ useAssetUrl: () => null }));
vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => null }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/queued-run-edit", () => ({ useQueuedRunEdit: () => null }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { queueWorkflowAtom: () => null, pendingRequestsAtom: () => null },
  threadEnvironment: {},
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../solus/use-session-controller", () => ({
  useSessionStore: () => ({
    controller: { mayDrive: true, changeQueue },
    meta: { subscribe: () => () => {} },
    metaSnapshotOf: () => snapshot,
  }),
}));

import { ThreadQueueSheet } from "./ThreadQueueControl";

const queue: SessionQueueSnapshot = {
  held: false,
  entries: [
    { queueId: "first", text: "First message", enqueuedAt: 1, reason: "busy" },
    { queueId: "second", text: "Edited message", enqueuedAt: 2, reason: "busy", revision: 3 },
  ],
};
const snapshot = { status: "running", questions: [], queue };

it.each([
  ["Send now, queued message 2", "steer", "second", 3],
  ["Remove queued message", "remove", "first", 0],
] as const)(
  "%s sends the selected message and revision to the host",
  async (label, kind, queueId, revision) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    alert.mockClear();
    changeQueue.mockClear();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(() =>
        root.render(
          <ThreadQueueSheet
            route={{
              params: { environmentId: EnvironmentId.make("mac"), threadId: ThreadId.make("thread") },
            }}
          />,
        ),
      );
      const action = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(action).not.toBeNull();
      await act(async () => action!.click());
      expect(alert).not.toHaveBeenCalled();
      expect(changeQueue).toHaveBeenCalledExactlyOnceWith({ kind, queueId, revision });
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
