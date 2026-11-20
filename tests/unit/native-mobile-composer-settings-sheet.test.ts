// T3 Code's settings-sheet presentation (use-thread-settings-sheet-presentation.ts, MIT; see
// apps/mobile/UPSTREAM.md). The model control opens a form sheet over the thread. The keyboard
// must come back after the sheet only when the person was typing, and the composer card must
// not collapse and expand again while focus returns.
import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

// react-dom carries its own React; the hook under test must share it.
const requireFromReactDom = createRequire(createRequire(import.meta.url).resolve("react-dom/package.json"));
const React = requireFromReactDom("react") as typeof import("react");
mock.module("react", () => React);
let keyboardVisible = false;
let keyboardDismissals = 0;
mock.module("react-native-keyboard-controller", () => ({
  KeyboardController: {
    isVisible: () => keyboardVisible,
    dismiss: async () => {
      keyboardDismissals += 1;
      keyboardVisible = false;
    },
  },
}));

const { useThreadSettingsSheetPresentation } = await import(
  "../../apps/mobile/src/features/threads/use-thread-settings-sheet-presentation"
);
type ComposerEditorHandle = import("../../apps/mobile/src/components/ComposerEditor").ComposerEditorHandle;
type Presentation = ReturnType<typeof useThreadSettingsSheetPresentation>;

const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = requireFromReactDom("react-dom/client") as typeof import("react-dom/client");
const act = React.act;

let presentation: Presentation;
let presented = 0;
let editorFocused = false;
let focusAttempts = 0;
/** Focus attempts UIKit refuses at the dismissal boundary before it accepts one. */
let refusedFocusAttempts = 0;
const editor: ComposerEditorHandle = {
  focus: () => {
    focusAttempts += 1;
    if (focusAttempts <= refusedFocusAttempts) return;
    editorFocused = true;
    keyboardVisible = true;
    presentation.onEditorFocusChange(true);
  },
  blur: () => {
    editorFocused = false;
    presentation.onEditorFocusChange(false);
  },
  isFocused: () => editorFocused,
  flushPendingInput: async () => {},
  setSelection: () => {},
};
const editorRef = { current: editor };

function Probe() {
  presentation = useThreadSettingsSheetPresentation({ editorRef, onPresent: () => { presented += 1; } });
  return null;
}

let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  jest.useFakeTimers();
  globalThis.requestAnimationFrame = (callback) => {
    setTimeout(() => callback(0), 16);
    return 0;
  };
  keyboardVisible = false;
  keyboardDismissals = 0;
  presented = 0;
  editorFocused = false;
  focusAttempts = 0;
  refusedFocusAttempts = 0;
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Probe)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  jest.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function typing() {
  editorFocused = true;
  keyboardVisible = true;
  presentation.onEditorFocusChange(true);
}

test("the sheet presents on the next frame, after the keyboard started to leave", async () => {
  typing();
  await act(async () => presentation.open());
  expect(keyboardDismissals).toBe(1);
  expect(editorFocused).toBe(false);
  expect(presented).toBe(0);
  // The card stays expanded while the keyboard leaves and the sheet comes up.
  expect(presentation.keepsComposerExpanded).toBe(true);
  await advance(16);
  expect(presented).toBe(1);
  expect(presentation.isVisible).toBe(true);
});

test("a person who was typing gets the keyboard back, and the card stays expanded until it is back", async () => {
  typing();
  await act(async () => presentation.open());
  await advance(16);
  await act(async () => presentation.onDismissed());
  // Focus waits for UIKit's dismissal to finish, or for the keyboard overlap.
  expect(focusAttempts).toBe(0);
  expect(presentation.keepsComposerExpanded).toBe(true);
  await act(async () => presentation.onStackTransitionsFinished());
  await advance(16);
  expect(editorFocused).toBe(true);
  await advance(50);
  expect(presentation.keepsComposerExpanded).toBe(false);
});

test("focus is tried again while UIKit refuses first responder at the dismissal boundary", async () => {
  typing();
  refusedFocusAttempts = 2;
  await act(async () => presentation.open());
  await advance(16);
  await act(async () => presentation.onDismissed());
  // Without the native completion event, the restore runs after the keyboard overlap.
  await advance(300);
  await advance(16);
  expect(editorFocused).toBe(false);
  await advance(100);
  expect(focusAttempts).toBe(3);
  expect(editorFocused).toBe(true);
});

test("a sheet opened without typing does not raise the keyboard when it closes", async () => {
  await act(async () => presentation.open());
  await advance(16);
  await act(async () => presentation.onDismissed());
  await act(async () => presentation.onStackTransitionsFinished());
  await advance(1_000);
  expect(focusAttempts).toBe(0);
  expect(keyboardVisible).toBe(false);
  expect(presentation.keepsComposerExpanded).toBe(false);
});

test("a composer that unmounts before the frame presents nothing", async () => {
  typing();
  await act(async () => presentation.open());
  await act(async () => presentation.dispose());
  await advance(16);
  expect(presented).toBe(0);
});
