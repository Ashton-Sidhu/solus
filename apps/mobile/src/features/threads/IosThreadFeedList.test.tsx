import { act, type PropsWithChildren } from "react";
import { createRoot } from "react-dom/client";
import type { SharedValue } from "react-native-reanimated";
import { expect, it, vi } from "vite-plus/test";
import { IosThreadFeedList } from "./IosThreadFeedList";

interface Frame {
  height: number;
  progress: number;
}
type KeyboardFrameHandlers = Partial<
  Record<"onStart" | "onMove" | "onInteractive" | "onEnd", (frame: Frame) => void>
>;
const native = vi.hoisted(() => {
  const handlers: KeyboardFrameHandlers = {};
  return { handlers, style: () => ({ marginBottom: 0 }) };
});
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { state: () => ({ height: 0 }) },
  useKeyboardHandler: (handlers: typeof native.handlers) => {
    native.handlers = handlers;
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: PropsWithChildren) => children },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (style: typeof native.style) => {
    native.style = style;
  },
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({
  NativeScrollViewMarker: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@legendapp/list/reanimated", () => ({ AnimatedLegendList: () => null }));

it("follows the visible keyboard frame through opening, interactive dismissal, and closing", () => {
  const root = createRoot(document.createElement("div"));
  // SAFETY: The list only reads `.value` from this mocked shared value.
  const composer = { value: 60 } as SharedValue<number>;
  try {
    act(() =>
      root.render(
        <IosThreadFeedList
          data={[]}
          renderItem={() => null}
          contentInsetEndAdjustment={composer}
          keyboardOffset={20}
        />,
      ),
    );
    native.handlers.onStart?.({ height: 320, progress: 1 });
    expect(native.style().marginBottom).toBe(60);
    native.handlers.onMove?.({ height: 160, progress: 0.5 });
    expect(native.style().marginBottom).toBe(210);
    native.handlers.onEnd?.({ height: 320, progress: 1 });
    expect(native.style().marginBottom).toBe(360);
    composer.value = 90;
    native.handlers.onInteractive?.({ height: 80, progress: 0.25 });
    expect(native.style().marginBottom).toBe(165);
    native.handlers.onEnd?.({ height: 0, progress: 0 });
    expect(native.style().marginBottom).toBe(90);
  } finally {
    act(() => root.unmount());
  }
});
