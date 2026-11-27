import {
  AssetWorkspaceAssetNotFoundError,
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import type { HostApi } from "@solus/client-core/host-api";
import { HostRpcError, TransportDisconnectedError } from "@solus/client-core/rpc-error";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/reactivity";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { AssetUrlState } from "./asset-url-state";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
  executeQuery: vi.fn(),
  preparedConnectionAtom: null as unknown,
  sign: vi.fn<HostApi["assetCreateUrl"]>(),
  hostMediaState: null as Atom.Atom<AssetUrlState> | null,
  hostGeneration: 1,
  canReadFiles: true,
}));

vi.mock("./mobile-host", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    fileAccountScope: Atom.make({ key: "account", organizationId: "org" }).pipe(Atom.keepAlive),
    mobileHost: Atom.family((id: string) =>
      Atom.make(() => ({
        api: { assetCreateUrl: state.sign },
        canReadFiles: state.canReadFiles,
        httpBaseUrl: `https://${id}.test`,
        generation: state.hostGeneration,
      })).pipe(Atom.keepAlive),
    ),
  };
});

// The Solus runtime starts the app (React Native); these tests open no thread.
vi.mock("../solus/runtime", () => ({
  solus: { threads: { thread: () => undefined }, openConversation: () => undefined },
}));
vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomMount: () => undefined,
  useAtomSubscribe: () => undefined,
  useAtomValue: (atom: Atom.Atom<AssetUrlState>) => {
    if (atom === state.assetAtom)
      return AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
    if (atom.label?.[0] === "host-media-state:none") return null;
    if (atom.label?.[0] === "host-media-state") {
      state.hostMediaState = atom;
      return appAtomRegistry.get(atom);
    }
    return AsyncResult.initial(false);
  },
}));
vi.mock("./session", () => ({
  environmentSession: {
    sessionStateAtom: () => ({}),
    preparedConnectionValueAtom: () => state.preparedConnectionAtom,
  },
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: state.phase, error: null } },
  }),
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: state.session, error: null }),
}));
vi.mock("./projectClones", () => ({ environmentProjectCloneListAtom: () => null }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { sessionGenerationAtom: () => null },
}));
vi.mock("@t3tools/client-runtime/state/assets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/assets")>()),
  createAssetEnvironmentAtoms: () => ({ createUrl: state.assetQuery }),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: state.executeQuery,
}));
vi.mock("./use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));
vi.mock("gt-react-native", async (importOriginal) => {
  const gt = await importOriginal<typeof import("gt-react-native")>();
  return { ...gt, useMessages: () => gt.mFallback };
});

import { refreshAssetUrl, useRefreshAssetUrl, useAssetUrlState } from "./assets";
import { appAtomRegistry } from "./atom-registry";
import { fileAccountScope, mobileHost } from "./mobile-host";
import { artifactPageAttachmentId } from "@solus/contracts/artifact-page";
import { resolveMarkdownMediaPreview } from "../lib/markdownMedia";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "workspace-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.sign.mockReset();
  state.hostMediaState = null;
  appAtomRegistry.set(fileAccountScope, { key: "account", organizationId: "org" });
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  (_tag) => {
    const file = { ...resource, _tag, path: "/repo/sound.mp3" };
    expect(useAssetUrlState(environmentId, file)).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(useAssetUrlState(environmentId, file)).toEqual({
      _tag: "Success",
      expiresAt: 1,
      url: "https://host.test/api/assets/image.png",
    });
  },
);

it("hides host assets with a denied grant while preserving attachments", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, resource)).toEqual({
    _tag: "Failure",
    reason: "missing-file-access",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" })).toEqual({
    _tag: "Success",
    expiresAt: 1,
    url: "https://host.test/api/assets/image.png",
  });
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource } });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBeNull();
});

it("rejects with the server's error and resolves null only without a connection", async () => {
  const missing = new AssetWorkspaceAssetNotFoundError({
    resource,
    checkedPath: "/repo/missing.png",
  });
  state.executeQuery.mockResolvedValue(AsyncResult.failure(Cause.fail(missing)));
  state.preparedConnectionAtom = Atom.make({
    _tag: "Some",
    value: { httpBaseUrl: "https://host.test" },
  });
  await expect(refreshAssetUrl(environmentId, resource)).rejects.toBe(missing);

  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  await expect(refreshAssetUrl(environmentId, resource)).resolves.toBeNull();
});

it("maps a Solus host's missing file reply to the native asset error", async () => {
  const image = { _tag: "media-file", threadId, path: "/repo/missing.png" } as const;
  state.sign.mockRejectedValueOnce(new HostRpcError("ENOENT: no such file or directory"));
  await expect(refreshAssetUrl(environmentId, image)).rejects.toBeInstanceOf(
    AssetWorkspaceAssetNotFoundError,
  );

  const disconnected = new TransportDisconnectedError();
  state.sign.mockRejectedValueOnce(disconnected);
  await expect(refreshAssetUrl(environmentId, image)).rejects.toBe(disconnected);
});

it("discards a missing file reply if the account changes during authorization", async () => {
  const image = { _tag: "media-file", threadId, path: "/repo/missing.png" } as const;
  state.sign.mockImplementationOnce(async () => {
    appAtomRegistry.set(fileAccountScope, { key: "other", organizationId: null });
    throw new HostRpcError("ENOENT: no such file or directory");
  });
  await expect(refreshAssetUrl(environmentId, image)).resolves.toBeNull();
});

it.each([
  ["/tmp/recording.mp4", "video", "/tmp/recording.mp4"],
  ["/tmp/solus-running-servers-dark.png", "image", "/tmp/solus-running-servers-dark.png"],
  ["./solus-running-servers-dark.png", "image", "/repo/./solus-running-servers-dark.png"],
] as const)("opens %s from its Solus host and re-signs it on retry", async (href, kind, path) => {
  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  const preview = resolveMarkdownMediaPreview(href, {
    environmentId,
    threadId,
    workspaceRoot: "/repo",
  });
  if (preview?.kind !== kind || !("resource" in preview.source))
    throw new Error("Expected a host media preview");
  const resource = preview.source.resource;
  state.sign
    .mockResolvedValueOnce({ relativeUrl: "/api/assets/first", expiresAt: 1 })
    .mockResolvedValueOnce({ relativeUrl: "/api/assets/second", expiresAt: 2 });

  await expect(refreshAssetUrl(environmentId, resource)).resolves.toBe(
    "https://asset-environment.test/api/assets/first",
  );
  await expect(useRefreshAssetUrl(environmentId, resource)()).resolves.toBe(
    "https://asset-environment.test/api/assets/second",
  );
  expect(state.sign).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: expect.objectContaining({ organizationId: "org" }) }),
    { path },
  );
});

it("signs a transcript photo for its original session before the upstream row loads it", async () => {
  const resource = { _tag: "attachment", attachmentId: "upload:original%2Fthread//uploads/photo.jpg",
    fileName: "photo.jpg", mimeType: "image/jpeg" } as const;
  state.sign.mockResolvedValue({ relativeUrl: "/api/assets/photo", expiresAt: 123 });
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Loading" });
  const atom = state.hostMediaState;
  if (!atom) throw new Error("Expected a scoped attachment read");
  const result = Promise.withResolvers<AssetUrlState>();
  const release = appAtomRegistry.subscribe(atom, value => {
    if (value._tag !== "Loading") result.resolve(value);
  }, { immediate: true });
  try {
    expect(await result.promise).toMatchObject({ _tag: "Success", url: "https://asset-environment.test/api/assets/photo" });
    expect(state.sign).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ sessionId: "original/thread", organizationId: "org" }) }),
      { path: "/uploads/photo.jpg" },
    );
  } finally {
    release();
  }
});

it.each(["/repo/videos/demo.mp4", "/repo/preview.png"])("loads an inline URL for %s from the Solus host", async (path) => {
  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  const resource = { _tag: "media-file", threadId, path } as const;
  state.sign.mockResolvedValueOnce({ relativeUrl: "/api/assets/demo", expiresAt: 1 });
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Loading" });
  const atom = state.hostMediaState;
  if (!atom) throw new Error("Expected host media state");
  const { promise, resolve } = Promise.withResolvers<AssetUrlState>();
  const unsubscribe = appAtomRegistry.subscribe(
    atom,
    (result) => {
      if (result._tag !== "Loading") resolve(result);
    },
    { immediate: true },
  );
  try {
    await expect(promise).resolves.toEqual({
      _tag: "Success",
      url: "https://asset-environment.test/api/assets/demo",
      expiresAt: 1,
    });
  } finally {
    unsubscribe();
  }
});

it("does not request an image URL when the host denies file access", async () => {
  const hostAtom = mobileHost(environmentId);
  try {
    state.canReadFiles = false;
    appAtomRegistry.refresh(hostAtom);
    const image = { _tag: "media-file", threadId, path: "/repo/preview.png" } as const;
    expect(useAssetUrlState(environmentId, image)).toEqual({
      _tag: "Failure",
      reason: "missing-file-access",
    });
    await expect(refreshAssetUrl(environmentId, image)).resolves.toBeNull();
    expect(state.sign).not.toHaveBeenCalled();
  } finally {
    state.canReadFiles = true;
    appAtomRegistry.refresh(hostAtom);
  }
});

it("discards the signed draft image URL if the account changes during authorization", async () => {
  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  state.sign.mockImplementationOnce(async () => {
    appAtomRegistry.set(fileAccountScope, { key: "other", organizationId: null });
    return { relativeUrl: "/api/assets/old", expiresAt: 1 };
  });
  await expect(
    refreshAssetUrl(environmentId, {
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "preview.png",
    }),
  ).resolves.toBeNull();
  expect(state.sign).toHaveBeenCalledWith(
    expect.objectContaining({
      session: expect.objectContaining({ workingDirectory: "/repo", organizationId: "org" }),
    }),
    { path: "preview.png" },
  );
});

it("rejects an image URL signed before reconnect and uses the new connection on retry", async () => {
  const hostAtom = mobileHost(environmentId);
  const image = { _tag: "media-file", threadId, path: "/repo/preview.png" } as const;
  try {
    state.sign.mockImplementationOnce(async () => {
      state.hostGeneration++;
      appAtomRegistry.refresh(hostAtom);
      return { relativeUrl: "/api/assets/old", expiresAt: 1 };
    });
    state.sign.mockResolvedValueOnce({ relativeUrl: "/api/assets/new", expiresAt: 2 });
    await expect(refreshAssetUrl(environmentId, image)).resolves.toBeNull();
    await expect(refreshAssetUrl(environmentId, image)).resolves.toBe(
      "https://asset-environment.test/api/assets/new",
    );
  } finally {
    state.hostGeneration = 1;
    appAtomRegistry.refresh(hostAtom);
  }
});

it("signs a saved artifact page on its Solus host, not through the T3 connection", async () => {
  // A T3 asset query for a Solus host never settles, so the page row would spin forever.
  const resource = { _tag: "attachment", attachmentId: artifactPageAttachmentId("work-1", 3),
    fileName: "graph.html", mimeType: "text/html", disposition: "inline" } as const;
  state.sign.mockResolvedValue({ relativeUrl: "/api/assets/page", expiresAt: 1 });
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Loading" });
  expect(state.assetQuery).not.toHaveBeenCalled();
  const atom = state.hostMediaState;
  if (!atom) throw new Error("Expected a host page read");
  const result = Promise.withResolvers<AssetUrlState>();
  const release = appAtomRegistry.subscribe(atom, value => {
    if (value._tag !== "Loading") result.resolve(value);
  }, { immediate: true });
  try {
    expect(await result.promise).toMatchObject({ _tag: "Success", url: "https://asset-environment.test/api/assets/page" });
    expect(state.sign).toHaveBeenCalledWith(expect.anything(), { assetId: "artifact:work-1:3" });
  } finally {
    release();
  }
});
