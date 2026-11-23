import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const { Slot, sharing } = vi.hoisted(() => ({
  Slot: ({ children }: { children?: ReactNode }) => children,
  sharing: {
    link: null as null | { secret: string; expiresAt: number },
    role: "owner",
    write: vi.fn(),
    refresh: vi.fn(),
  },
}));
vi.mock("../../solus/use-host-settings-read", () => ({
  useHostSettingsRead: () => ({
    api: { shareSetLink: sharing.write },
    data: { list: { callerRole: sharing.role, link: sharing.link }, origin: "https://share.test" },
    refresh: sharing.refresh,
  }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ScrollView: Slot,
  View: Slot,
  Share: {},
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => {} }),
  usePreventRemove: () => {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Slot }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../components/ui/ScreenContent", () => ({ ScreenContent: Slot }));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: () => true }));

import { ThreadGuestShareSheet } from "./ThreadGuestShareSheet";

it("creates a viewer link only on request, hides it at expiry, and preserves the viewer boundary", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    root.render(
      <ThreadGuestShareSheet
        route={{
          params: { environmentId: EnvironmentId.make("mac"), threadId: ThreadId.make("thread") },
        }}
      />,
    );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  try {
    await act(render);
    expect(sharing.write).not.toHaveBeenCalled();
    await act(async () => button("Create viewer link")!.click());
    expect(sharing.write).toHaveBeenCalledWith({
      resource: { kind: "session", id: "thread" },
      role: "viewer",
      expiresInMs: 86400000,
      regenerate: false,
    });
    sharing.link = { secret: "example", expiresAt: 1000 };
    await act(render);
    expect(container.textContent).toContain("#example");
    await act(async () => button("Stop sharing by link")!.click());
    expect(sharing.write).toHaveBeenLastCalledWith({
      resource: { kind: "session", id: "thread" },
      role: null,
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(container.textContent).not.toContain("#example");
    sharing.role = "viewer";
    await act(render);
    expect(container.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
