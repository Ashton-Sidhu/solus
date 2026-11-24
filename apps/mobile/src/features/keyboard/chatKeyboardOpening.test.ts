import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { KeyboardHandler } from "react-native-keyboard-controller";
import type {
  UseChatKeyboardOptions,
  UseChatKeyboardReturn,
} from "react-native-keyboard-controller/src/components/KeyboardChatScrollView/useChatKeyboard/types";
import type { AnimatedRef, SharedValue } from "react-native-reanimated";
import type Animated from "react-native-reanimated";

const { native, sharedValue } = vi.hoisted(() => {
  // SAFETY: The keyboard worklet only reads and writes `.value` in these tests.
  const sharedValue = <T>(value: T) => ({ value }) as SharedValue<T>;
  const keyboard: KeyboardHandler = {};
  return { native: { keyboard, scroll: sharedValue(680) }, sharedValue };
});

vi.mock("react-native-reanimated", () => ({
  useSharedValue: sharedValue,
  interpolate: (value: number, [start, end]: [number, number], [from, to]: [number, number]) =>
    from + ((value - start) / (end - start)) * (to - from),
}));
vi.mock("react-native-keyboard-controller/src/hooks", () => ({
  useKeyboardHandler: (handlers: KeyboardHandler) => {
    native.keyboard = handlers;
  },
}));
vi.mock("react-native-keyboard-controller/src/components/hooks/useScrollState", () => ({
  default: () => ({
    layout: { value: { width: 400, height: 600 } },
    size: { value: { width: 400, height: 1200 } },
    offset: native.scroll,
  }),
}));

// Load the native hook at runtime so the mobile typecheck uses the package's declarations.
const { useChatKeyboard: runChatKeyboard } = await vi.importActual<{
  useChatKeyboard(
    scrollView: AnimatedRef<Animated.ScrollView>,
    options: UseChatKeyboardOptions,
  ): UseChatKeyboardReturn;
}>(
  "react-native-keyboard-controller/src/components/KeyboardChatScrollView/useChatKeyboard/index.ios",
);

beforeEach(() => {
  native.scroll.value = 680;
});

function setup(blankSpace = 0, keyboardLiftBehavior: "whenAtEnd" | "persistent" = "whenAtEnd") {
  // SAFETY: The mocked native scroll state never reads this ref.
  const { contentOffsetY, padding } = runChatKeyboard({} as AnimatedRef<Animated.ScrollView>, {
    inverted: false,
    keyboardLiftBehavior,
    freeze: sharedValue(false),
    offset: 20,
    blankSpace: sharedValue(blankSpace),
    extraContentPadding: sharedValue(80),
    adjustedInsetCompensation: 0,
    adjustedStartInsetCompensation: 0,
    initialContentOffsetY: native.scroll.value,
  });
  if (!contentOffsetY) throw new Error("The iOS chat keyboard must provide a scroll offset.");
  return { contentOffsetY, padding };
}

function emit(event: keyof KeyboardHandler, height: number, duration = 250) {
  native.keyboard[event]?.({ height, progress: height / 320, duration, target: 1 });
}

it("keeps the latest message aligned with the composer throughout the keyboard opening", () => {
  const { contentOffsetY, padding } = setup();
  const position = () => [padding.value, contentOffsetY.value];

  emit("onStart", 320);
  expect(position()).toEqual([0, 680]);
  emit("onMove", 160);
  expect(position()).toEqual([150, 830]);
  emit("onEnd", 320);
  expect(position()).toEqual([300, 980]);
});

it("keeps the reader's offset when the keyboard opens while they are reading earlier messages", () => {
  const { contentOffsetY, padding } = setup();
  native.scroll.value = 240;

  emit("onStart", 320);
  emit("onMove", 160);
  expect(padding.value).toBe(150);
  // An inset change must not write the old offset back to the native scroll view.
  expect(contentOffsetY.value).toBe(680);
  emit("onEnd", 320);
  expect(contentOffsetY.value).toBe(680);
});

it("uses the visible space below the latest message before lifting it", () => {
  native.scroll.value = 780;
  const { contentOffsetY } = setup(180);

  emit("onStart", 320);
  emit("onMove", 80);
  expect(contentOffsetY.value).toBe(780);
  emit("onMove", 160);
  expect(contentOffsetY.value).toBe(830);
});

it("applies an instant keyboard show without waiting for a movement event", () => {
  const { contentOffsetY, padding } = setup();

  emit("onStart", 320, 0);
  expect([padding.value, contentOffsetY.value]).toEqual([300, 980]);
});

it("keeps the send-time close clamped to the remaining scroll range", () => {
  const { contentOffsetY, padding } = setup(0, "persistent");
  emit("onStart", 320);
  emit("onEnd", 320);
  // The newly submitted message can be above the end while the keyboard is closing.
  native.scroll.value = 590;

  emit("onStart", 0);
  emit("onEnd", 0);

  expect([padding.value, contentOffsetY.value]).toEqual([0, 590]);
});
