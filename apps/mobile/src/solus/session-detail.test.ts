import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { sessionDetailAtom } from "./session-detail";

const host = vi.hoisted(() => ({
  account: "first",
  read: vi.fn(() => ({})),
  observe: vi.fn(() => () => {}),
}));
vi.mock("./runtime", () => ({
  solus: {
    sessionCache: { scope: () => host.account },
    threads: { thread: () => ({ record: {} }) },
    openConversation: () => null,
    conversation: host.read,
    observeConversation: host.observe,
  },
}));

it("hands the navigation read to the screen and starts a new read after an account switch", () => {
  const registry = AtomRegistry.make();
  try {
    const atom = sessionDetailAtom("host", "thread");
    const finishNavigation = registry.mount(atom);
    const screen = sessionDetailAtom("host", "thread");
    const closeScreen = registry.mount(screen);
    expect(registry.get(screen)).toBe(registry.get(atom));
    finishNavigation();
    expect(host.read).toHaveBeenCalledTimes(1);
    expect(host.observe).toHaveBeenCalledTimes(1);
    host.account = "second";
    const other = sessionDetailAtom("host", "thread");
    expect(registry.get(other)).not.toBe(registry.get(screen));
    closeScreen();
  } finally {
    registry.dispose();
    host.account = "first";
  }
});
