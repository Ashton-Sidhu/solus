import {
  AssetWorkspaceAssetNotFoundError,
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
} from "@t3tools/contracts";
import type { HostApi } from "@solus/client-core/host-api";
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
  hostVideoState: null as Atom.Atom<AssetUrlState> | null,
  hostGeneration: 1,
}));

vi.mock("./mobile-host", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    fileAccountScope: Atom.make({ key: "account", organizationId: "org" }).pipe(Atom.keepAlive),
    mobileHost: Atom.family((id: string) =>
      Atom.make(() => ({
        api: { assetCreateUrl: state.sign },
        canReadFiles: true,
        httpBaseUrl: `https://${id}.test`,
        generation: state.hostGeneration,
      })).pipe(Atom.keepAlive),
    ),
  };
});

vi.mock("react", () => ({ useCallback: <A>(callback: A) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomMount: () => undefined,
  useAtomSubscribe: () => undefined,
  useAtomValue: (atom: Atom.Atom<AssetUrlState>) => {
    if (atom === state.assetAtom)
      return AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
    if (atom.label?.[0] === "host-video-state:none") return null;
    if (atom.label?.[0] === "host-video-state") {
      state.hostVideoState = atom;
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
import { resolveMarkdownMediaPreview } from "../lib/markdownMedia";

const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.sign.mockReset();
  state.hostVideoState = null;
  appAtomRegistry.set(fileAccountScope, { key: "account", organizationId: "org" });
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: 1 }));
});

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  (_tag) => {
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({
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

it("opens a host recording without a T3 connection and re-signs it on retry", async () => {
  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  const path = "/tmp/recording.mp4";
  const preview = resolveMarkdownMediaPreview(path, {
    environmentId,
    threadId,
    workspaceRoot: "/repo",
  });
  if (preview?.kind !== "video" || !("resource" in preview.source))
    throw new Error("Expected a host video preview");
  const video = preview.source.resource;
  state.sign
    .mockResolvedValueOnce({ relativeUrl: "/api/assets/first", expiresAt: 1 })
    .mockResolvedValueOnce({ relativeUrl: "/api/assets/second", expiresAt: 2 });

  await expect(refreshAssetUrl(environmentId, video)).resolves.toBe(
    "https://asset-environment.test/api/assets/first",
  );
  await expect(useRefreshAssetUrl(environmentId, video)()).resolves.toBe(
    "https://asset-environment.test/api/assets/second",
  );
  expect(state.sign).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: expect.objectContaining({ organizationId: "org" }) }),
    { path },
  );
});

it("loads an inline video URL from the Solus host", async () => {
  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  const video = { _tag: "media-file", threadId, path: "/repo/videos/demo.mp4" } as const;
  state.sign.mockResolvedValueOnce({ relativeUrl: "/api/assets/demo", expiresAt: 1 });
  expect(useAssetUrlState(environmentId, video)).toEqual({ _tag: "Loading" });
  const atom = state.hostVideoState;
  if (!atom) throw new Error("Expected video asset state");
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

it("discards the signed video URL if the account changes during authorization", async () => {
  state.preparedConnectionAtom = Atom.make({ _tag: "None" });
  state.sign.mockImplementationOnce(async () => {
    appAtomRegistry.set(fileAccountScope, { key: "other", organizationId: null });
    return { relativeUrl: "/api/assets/old", expiresAt: 1 };
  });
  await expect(
    refreshAssetUrl(environmentId, {
      _tag: "draft-workspace-file",
      cwd: "/repo",
      path: "video.mp4",
    }),
  ).resolves.toBeNull();
  expect(state.sign).toHaveBeenCalledWith(
    expect.objectContaining({
      session: expect.objectContaining({ workingDirectory: "/repo", organizationId: "org" }),
    }),
    { path: "video.mp4" },
  );
});

it("rejects a URL signed before reconnect and uses the new connection on retry", async () => {
  const hostAtom = mobileHost(environmentId);
  const video = { _tag: "media-file", threadId, path: "/repo/video.mp4" } as const;
  try {
    state.sign.mockImplementationOnce(async () => {
      state.hostGeneration++;
      appAtomRegistry.refresh(hostAtom);
      return { relativeUrl: "/api/assets/old", expiresAt: 1 };
    });
    state.sign.mockResolvedValueOnce({ relativeUrl: "/api/assets/new", expiresAt: 2 });
    await expect(refreshAssetUrl(environmentId, video)).resolves.toBeNull();
    await expect(refreshAssetUrl(environmentId, video)).resolves.toBe(
      "https://asset-environment.test/api/assets/new",
    );
  } finally {
    state.hostGeneration = 1;
    appAtomRegistry.refresh(hostAtom);
  }
});
