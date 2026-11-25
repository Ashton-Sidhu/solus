import { attachmentUrl } from "./attachment-resource";
import { uploadAttachmentId } from "./upload-attachment-id";
import { appAtomRegistry } from "../state/atom-registry";
import { expect, it, vi } from "vite-plus/test";
import type { HostApi } from "@solus/client-core/host-api";
import { AtomRegistry } from "effect/reactivity";
import { EnvironmentId } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { fileAccountScope } from "../state/mobile-host";
import { checkoutAssetUrl, searchEntries, readCheckoutEntry } from "./checkout-files";

const calls = vi.hoisted(() => ({
  assetCreateUrl: vi.fn<HostApi["assetCreateUrl"]>(),
  listProjectFiles: vi.fn<HostApi["listProjectFiles"]>(),
}));
vi.mock("../state/mobile-host", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    fileAccountScope: Atom.make({ key: "", organizationId: null }).pipe(Atom.keepAlive),
    mobileHost: Atom.family((id: string) =>
      Atom.make({ api: calls, canReadFiles: true, httpBaseUrl: "https://" + id + ".example" }),
    ),
  };
});

it("reads preview bytes from the selected worktree and organization in one call", async () => {
  const readProjectFile = vi.fn<HostApi["readProjectFile"]>().mockResolvedValue({
    ok: true,
    kind: "text",
    contents: "worktree",
    path: "/worktree/file",
    displayPath: "file",
    size: 8,
    isReadOnly: false,
  });
  const listDirectory = vi.fn<HostApi["listDirectory"]>();
  const entry = await readCheckoutEntry(
    { readProjectFile, listDirectory },
    { cwd: "/worktree", relativePath: "file" },
    "org",
  );
  expect(entry.kind).toBe("text");
  expect(readProjectFile).toHaveBeenCalledWith(
    expect.objectContaining({
      session: expect.objectContaining({ organizationId: "org", workingDirectory: "/worktree" }),
    }),
    { cwd: "/worktree", path: "file" },
  );
  expect(listDirectory).not.toHaveBeenCalled();
});

it("opens a directory identified by the host without listing its contents", async () => {
  const readProjectFile = vi.fn<HostApi["readProjectFile"]>().mockResolvedValue({
    ok: false, path: "/worktree/docs", error: "Only files can be previewed.", isDirectory: true,
  });
  const listDirectory = vi.fn<HostApi["listDirectory"]>();
  const target = { cwd: "/worktree", relativePath: "docs" };
  await expect(readCheckoutEntry({ readProjectFile, listDirectory }, target, null)).resolves.toEqual({ kind: "directory" });
  readProjectFile.mockResolvedValue({ ok: false, path: "docs", error: "Permission denied", isDirectory: false });
  await expect(readCheckoutEntry({ readProjectFile, listDirectory }, target, null)).rejects.toThrow("Permission denied");
  expect(listDirectory).not.toHaveBeenCalled();
});

it("opens a directory link and preserves the host error for a missing file", async () => {
  const readProjectFile = vi
    .fn<HostApi["readProjectFile"]>()
    .mockResolvedValue({ ok: false, path: "/worktree/sub", error: "File unavailable" });
  const listDirectory = vi.fn<HostApi["listDirectory"]>().mockResolvedValue({
    entries: [],
    error: null,
    parentPath: "/worktree",
    currentPath: "/worktree/sub",
  });
  const target = { cwd: "/worktree", relativePath: "sub" };
  await expect(
    readCheckoutEntry({ readProjectFile, listDirectory }, target, null),
  ).resolves.toEqual({ kind: "directory" });
  expect(listDirectory).toHaveBeenCalledWith("/worktree/sub", true);
  listDirectory.mockResolvedValue({
    entries: [],
    error: "Missing",
    parentPath: "/worktree",
    currentPath: "/worktree/sub",
  });
  await expect(readCheckoutEntry({ readProjectFile, listDirectory }, target, null)).rejects.toThrow(
    "File unavailable",
  );
});

it("searches the same host index as text changes, including empty folders", async () => {
  const registry = AtomRegistry.make();
  registry.set(fileAccountScope, { key: "scope", organizationId: "org" });
  calls.listProjectFiles.mockResolvedValue({
    ok: true,
    root: "/repo",
    files: ["docs/notes.md"],
    emptyDirectories: ["docs/empty/"],
    truncated: false,
    source: "index",
  });
  const query = (text: string) =>
    searchEntries({
      accountKey: "scope",
      environmentId: EnvironmentId.make("first"),
      input: { cwd: "/repo", query: text, limit: 10 },
    });
  const stop = registry.mount(query("notes"));
  try {
    await executeAtomQuery(registry, query("notes"));
    const result = await executeAtomQuery(registry, query("empty"));
    expect(result._tag === "Success" && result.value.entries).toEqual([
      { kind: "directory", path: "docs/empty" },
    ]);
    expect(calls.listProjectFiles).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    registry.dispose();
  }
});

it("uses the signing host's origin and rejects requests from a previous account", async () => {
  const registry = AtomRegistry.make();
  registry.set(fileAccountScope, { key: "scope", organizationId: "org" });
  calls.assetCreateUrl.mockResolvedValue({ relativeUrl: "/assets/signed", expiresAt: 12345 });
  try {
    const params = {
      environmentId: EnvironmentId.make("second"),
      accountKey: "scope",
      input: { cwd: "/repo", path: "/repo/file.pdf" },
    };
    const result = await executeAtomQuery(registry, checkoutAssetUrl(params));
    expect(result._tag === "Success" && result.value).toBe("https://second.example/assets/signed");
    registry.set(fileAccountScope, { key: "next", organizationId: null });
    const old = await executeAtomQuery(registry, checkoutAssetUrl(params), {
      refresh: true,
      reportFailure: false,
    });
    expect(old._tag).toBe("Failure");
    expect(calls.assetCreateUrl).toHaveBeenCalledTimes(1);
  } finally {
    registry.dispose();
  }
});

it("signs a document on the uploading session and drops the result after an account change", async () => {
  const host = EnvironmentId.make("uploads");
  const id = uploadAttachmentId("draft/1", "/attachments/notes.md");
  const signed = { relativeUrl: "/api/assets/signed", expiresAt: 123 };
  appAtomRegistry.set(fileAccountScope, { key: "one", organizationId: "org" });
  calls.assetCreateUrl.mockResolvedValueOnce(signed);
  expect(await attachmentUrl(host, id, "notes.md")).toBe("https://uploads.example/api/assets/signed");
  expect(calls.assetCreateUrl).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: expect.objectContaining({sessionId: "draft/1", organizationId:"org"}) }),
    { path: "/attachments/notes.md" }
  );
  calls.assetCreateUrl.mockImplementationOnce(async () => {
    appAtomRegistry.set(fileAccountScope, {key:"two", organizationId:null});
    return signed;
  });
  expect(await attachmentUrl(host, id)).toBeNull();
});
