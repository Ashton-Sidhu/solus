// @vitest-environment jsdom
import { AtomRegistry } from "effect/reactivity";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { sessionDetailAtom, useOpeningHistoryPreview } from "./session-detail";

const host = vi.hoisted(() => ({
  account: "first",
  listeners: new Set<() => void>(),
  read: vi.fn(() => ({})),
  hasHistoryKey: vi.fn<() => boolean | undefined>(() => false),
  observe: vi.fn(() => () => {}),
}));
vi.mock("./runtime", () => ({
  solus: {
    account: {
      changes: {
        subscribe: (listener: () => void) => {
          host.listeners.add(listener);
          return () => { host.listeners.delete(listener); };
        },
      },
    },
    sessionCache: { scope: () => host.account, forHost: () => ({ hasHistoryKey: host.hasHistoryKey }) },
    threads: { thread: () => ({ record: {} }) },
    openConversation: () => null,
    conversation: host.read,
    observeConversation: host.observe,
  },
}));

it.each([
  [false, true],
  [true, false],
  [undefined, false],
] as const)("previews the first mount only for a known history miss (%s)", async (cached, expected) => {
  host.hasHistoryKey.mockReturnValueOnce(cached);
  const registry = AtomRegistry.make();
  const detail = sessionDetailAtom("host", "thread");
  const close = registry.mount(detail);
  const store = registry.get(detail)!;
  const node = document.createElement("div");
  const root = createRoot(node);
  function Screen() {
    return String(useOpeningHistoryPreview(store));
  }
  try {
    await act(() => root.render(createElement(Screen)));
    expect(node.textContent).toBe(String(expected));
    await act(() => root.render(createElement(Screen, { key: "reopen" })));
    expect(node.textContent).toBe("false");
  } finally {
    await act(() => root.unmount());
    close();
    registry.dispose();
  }
});

it("hands the navigation read to the screen and starts a new read after an account switch", () => {
  host.read.mockClear();
  host.observe.mockClear();
  const registry = AtomRegistry.make();
  try {
    const atom = sessionDetailAtom("host", "thread");
    const finishNavigation = registry.mount(atom);
    const screen = sessionDetailAtom("host", "thread");
    const closeScreen = registry.mount(screen);
    const firstAccountStore = registry.get(screen);
    expect(firstAccountStore).toBe(registry.get(atom));
    finishNavigation();
    expect(host.read).toHaveBeenCalledTimes(1);
    expect(host.observe).toHaveBeenCalledTimes(1);
    host.account = "second";
    for (const listener of [...host.listeners]) listener();
    expect(registry.get(screen)).not.toBe(firstAccountStore);
    closeScreen();
  } finally {
    registry.dispose();
    host.account = "first";
  }
});
