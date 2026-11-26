// @vitest-environment jsdom
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { sessionDetailAtom } from "./session-detail";

const host = vi.hoisted(() => ({
  account: "first",
  listeners: new Set<() => void>(),
  read: vi.fn(() => ({})),
  retained: vi.fn<() => { sessionId: string } | null>(() => null),
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
    sessionCache: { scope: () => host.account },
    threads: { thread: () => ({ record: {} }) },
    openConversation: host.retained,
    conversation: host.read,
    observeConversation: host.observe,
  },
}));

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
