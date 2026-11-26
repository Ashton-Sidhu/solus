import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ComposerDraftProject } from "../state/use-composer-drafts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

interface TestRecord {
  sessionId: string;
  title: string;
  organizationId: null;
}

const state = vi.hoisted(() => ({
  cacheRead: false,
  scope: "first",
  readiness: "ready",
  historyPhase: "ready",
  rows: [] as string[],
  records: new Map<string, TestRecord>(),
  listeners: new Set<() => void>(),
  read: vi.fn<(sessionId: string) => Promise<TestRecord | null>>(),
  observe: vi.fn(() => () => {}),
  retry: vi.fn(),
  chooseCodebase: vi.fn(),
  draftProject: vi.fn<() => ComposerDraftProject | undefined>(),
  availableCodebase: "",
  isReadingCodebases: false,
}));

vi.mock("../state/use-composer-drafts", () => ({
  useComposerDraftProject: (key?: string) => key === "saved-draft" ? state.draftProject() : undefined,
}));

vi.mock("./runtime", () => {
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => { state.listeners.delete(listener); };
  };
  const changes = { subscribe };
  return {
    useSolusWorkspace: () => ({
      environments: [],
      projects: [],
      hostsById: {
        host: {
          connectionState: state.readiness === "ready" ? "connected" : "connecting",
          connectionError: state.readiness === "ready" ? null : "The host is reconnecting.",
        },
      },
      state: { isLoadingConnections: false },
    }),
    useSolusShellCachesRead: () => state.cacheRead,
    solus: {
      registry: { host: () => ({ label: "Test host" }) },
      account: { changes, organizationId: null },
      personal: { current: () => ({ activeAgent: "codex" }) },
      codebases: {
        changes,
        hosts: () => [{ hostId: "host", isReady: true, status: state.isReadingCodebases ? "loading" : "ready" }],
        codebasesOfFolder: (hostId: string, path: string) =>
          hostId === "host" && path === "/shop" && state.availableCodebase
            ? [{ id: state.availableCodebase }]
            : [],
      },
      connections: {
        changes,
        state: () => ({ readiness: state.readiness }),
        may: () => true,
        connection: () => ({ api: { sessionRecordGet: state.read } }),
        retry: state.retry,
      },
      threads: {
        changes,
        stateOf: () => ({ kind: "idle" }),
        cloudHostIds: () => new Set(),
        thread: (_hostId: string, sessionId: string) => {
          const record = state.records.get(sessionId);
          return record ? { record } : null;
        },
        rememberSearchResult: ({ record }: { record: TestRecord }) => {
          state.records.set(record.sessionId, record);
          notify();
        },
      },
      sessionCache: { scope: () => state.scope, forHost: () => ({ hasHistoryKey: () => false }) },
      newSessionId: () => "draft",
      openConversation: () => null,
      conversation: (hostId: string, target: { record?: TestRecord; newSession?: { sessionId: string } }) => ({
        meta: changes,
        orderSnapshot: () => state.rows,
        controller: {
          get phase() { return { kind: state.historyPhase }; },
          hostId,
          run: { sessionId: target.record?.sessionId ?? target.newSession?.sessionId },
          title: target.record?.title,
          chooseCodebase: state.chooseCodebase,
        },
      }),
      observeConversation: state.observe,
    },
  };
});

import { useThreadSession } from "./use-thread-session";

function notify() {
  for (const listener of [...state.listeners]) listener();
}

function record(sessionId: string, title: string): TestRecord {
  return { sessionId, title, organizationId: null };
}

function mountRoute() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.cacheRead = false;
  state.scope = "first";
  state.readiness = "ready";
  state.historyPhase = "ready";
  state.rows = [];
  state.records.clear();
  state.read.mockReset();
  state.retry.mockClear();
  state.observe.mockClear();
  state.chooseCodebase.mockClear();
  state.draftProject.mockReset();
  state.availableCodebase = "";
  state.isReadingCodebases = false;
  const registry = AtomRegistry.make();
  const root = createRoot(document.createElement("div"));
  let current: ReturnType<typeof useThreadSession>;
  function Route(props: Parameters<typeof useThreadSession>[0]) {
    current = useThreadSession(props);
    return null;
  }
  return {
    get current() { return current; },
    render: (threadId: string, draft?: Parameters<typeof useThreadSession>[0]["draft"]) =>
      act(async () => {
        root.render(
          <RegistryContext.Provider value={registry}>
            <Route threadId={threadId} environmentId="host" draft={draft} />
          </RegistryContext.Provider>,
        );
      }),
    close: () => {
      act(() => root.unmount());
      registry.dispose();
    },
  };
}

it("restores an explicit codebase only when it holds the saved draft folder", async () => {
  const route = mountRoute();
  const draft = { draftId: "saved-draft", environmentId: "host", projectId: "/shop" };
  state.draftProject.mockReturnValue({
    environmentId: EnvironmentId.make("host"),
    projectId: ProjectId.make("/shop"),
    codebaseId: "shop",
    createdAt: "2026-11-24T00:00:00Z",
  });
  state.isReadingCodebases = true;
  try {
    await route.render("draft", draft);
    expect(route.current.kind).toBe("loading");
    expect(state.chooseCodebase).not.toHaveBeenCalled();

    await act(async () => {
      state.availableCodebase = "shop";
      state.isReadingCodebases = false;
      notify();
    });
    expect(state.chooseCodebase).toHaveBeenCalledExactlyOnceWith("shop");
    expect(route.current.kind).toBe("ready");
    expect(state.observe).toHaveBeenCalledOnce();
  } finally {
    route.close();
  }
});

it("mounts the saved conversation with its first rows while the watch is loading", async () => {
  const route = mountRoute();
  try {
    state.historyPhase = "loading";
    state.records.set("session", record("session", "Saved session"));
    await route.render("session");
    expect(route.current.kind).toBe("loading");
    await act(async () => {
      state.rows = ["first reply"];
      notify();
    });
    expect(route.current.kind).toBe("ready");
    expect(state.observe).toHaveBeenCalledOnce();
  } finally {
    route.close();
  }
});

it("opens a cached session with one watch and no exact record request", async () => {
  const route = mountRoute();
  try {
    state.records.set("session", record("session", "Cached session"));
    await route.render("session");
    expect(route.current.kind).toBe("ready");
    expect(state.read).not.toHaveBeenCalled();
    expect(state.observe).toHaveBeenCalledOnce();
  } finally {
    route.close();
  }
});

it("waits for the phone cache, then retries an exact host read outside the list", async () => {
  const route = mountRoute();
  try {
    state.read.mockRejectedValueOnce(new Error("Temporary read failure"));
    state.read.mockResolvedValueOnce(record("older", "Older session"));
    await route.render("older");
    expect(route.current.kind).toBe("loading");
    expect(state.read).not.toHaveBeenCalled();

    state.cacheRead = true;
    await route.render("older");
    expect(route.current).toMatchObject({
      kind: "unavailable",
      detail: "Temporary read failure",
      recovery: { kind: "retry" },
    });
    const failed = route.current;
    if (failed.kind !== "unavailable") throw new Error("Expected the retry action.");
    await act(async () => failed.recovery?.run());
    expect(route.current.kind).toBe("ready");
    expect(state.read.mock.calls).toEqual([["older"], ["older"]]);
  } finally {
    route.close();
  }
});

it("drops an old account reply and reads the session again on the current account", async () => {
  const route = mountRoute();
  try {
    state.cacheRead = true;
    const oldReply = Promise.withResolvers<TestRecord | null>();
    const newReply = Promise.withResolvers<TestRecord | null>();
    state.read.mockReturnValueOnce(oldReply.promise).mockReturnValueOnce(newReply.promise);
    await route.render("session");
    expect(route.current.kind).toBe("loading");
    await act(async () => {
      state.scope = "second";
      notify();
    });
    expect(state.read.mock.calls).toEqual([["session"], ["session"]]);
    await act(async () => oldReply.resolve(record("session", "Old account")));
    expect(state.records.has("session")).toBe(false);
    expect(route.current.kind).toBe("loading");
    await act(async () => newReply.resolve(record("session", "Current account")));
    expect(state.records.get("session")?.title).toBe("Current account");
    expect(route.current.kind).toBe("ready");
  } finally {
    route.close();
  }
});

it("keeps the route during reconnect and opens the session when its host returns", async () => {
  const route = mountRoute();
  try {
    state.cacheRead = true;
    state.readiness = "reconnecting";
    await route.render("session");
    const unavailable = route.current;
    expect(unavailable).toMatchObject({ kind: "unavailable", recovery: { kind: "reconnect" } });
    if (unavailable.kind !== "unavailable") throw new Error("Expected the reconnect action.");
    unavailable.recovery?.run();
    expect(state.retry).toHaveBeenCalledWith("host");
    expect(state.read).not.toHaveBeenCalled();
    state.read.mockResolvedValueOnce(record("session", "Reconnected session"));
    await act(async () => {
      state.readiness = "ready";
      notify();
    });
    expect(route.current.kind).toBe("ready");
    expect(state.read).toHaveBeenCalledWith("session");
  } finally {
    route.close();
  }
});
