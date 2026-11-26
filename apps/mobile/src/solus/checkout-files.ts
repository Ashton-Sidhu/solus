import type { HostApi } from "@solus/client-core/host-api";
import type { FilePreviewRequest } from "@solus/contracts/types";
import { projectContext } from "@solus-mobile/features/conversation/lib/ipc-context";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { resolveWorkspaceFilePath } from "../features/files/filePath";
import { fileAccountScope, mobileHost } from "../state/mobile-host";

class CheckoutReadError extends Schema.TaggedError<CheckoutReadError>()("CheckoutReadError", {
  message: Schema.String,
}) {}

function checkoutQuery<Input extends { cwd: string }, T>(
  read: (
    api: HostApi,
    input: Input,
    organizationId: string | null,
    httpBaseUrl: string,
  ) => Promise<T>,
) {
  return Atom.family((query: { environmentId: EnvironmentId; accountKey: string; input: Input }) =>
    Atom.make((get) => {
      const host = get(mobileHost(query.environmentId));
      const scope = get(fileAccountScope);
      if (!host?.canReadFiles || scope.key !== query.accountKey)
        return Effect.fail(new CheckoutReadError({ message: "Host files are unavailable." }));
      return Effect.tryPromise({
        try: () => read(host.api, query.input, scope.organizationId, host.httpBaseUrl),
        catch: (cause) =>
          new CheckoutReadError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    }),
  );
}

export const listEntries = checkoutQuery(
  async (api, { cwd, directoryPath }: { cwd: string; directoryPath: string }) => {
    const result = await api.listDirectory(
      directoryPath ? resolveWorkspaceFilePath(cwd, directoryPath) : cwd,
      true,
    );
    if (result.error) throw new Error(result.error);
    return {
      entries: result.entries.map((entry): ProjectEntry => ({
        kind: entry.isDir ? "directory" : "file",
        path: directoryPath ? directoryPath + "/" + entry.name : entry.name,
      })),
      truncated: false,
    };
  },
);

const checkoutIndex = checkoutQuery(async (api, { cwd }: { cwd: string }, organizationId) => {
  const result = await api.listProjectFiles(projectContext(cwd, organizationId), {
    cwd,
    includeEmptyDirectories: true,
  });
  if (!result.ok) throw new Error(result.error);
  return result;
});

export const searchEntries = Atom.family(
  ({
    environmentId,
    accountKey,
    input,
  }: {
    environmentId: EnvironmentId;
    accountKey: string;
    input: { cwd: string; query: string; limit: number };
  }) =>
    Atom.map(checkoutIndex({ environmentId, accountKey, input: { cwd: input.cwd } }), (result) =>
      AsyncResult.map(result, (index) => {
        const entries: ProjectEntry[] = [];
        const needle = input.query.toLowerCase();
        const groups = [
          ["file", index.files],
          ["directory", index.emptyDirectories ?? []],
        ] as const;
        for (const [kind, paths] of groups) {
          for (const path of paths) {
            if (!path.toLowerCase().includes(needle)) continue;
            if (entries.length === input.limit) return { entries, truncated: true };
            entries.push({ kind, path: path.replace(/\/$/, "") });
          }
        }
        return { entries, truncated: index.truncated };
      }),
    ),
);

export async function readCheckoutEntry(
  api: Pick<HostApi, "readProjectFile" | "listDirectory">,
  { cwd, relativePath }: { cwd: string; relativePath: string },
  organizationId: string | null,
  textPage?: FilePreviewRequest["textPage"],
) {
  const request: FilePreviewRequest = {
    cwd,
    path: relativePath,
  };
  if (textPage) request.textPage = textPage;
  const result = await api.readProjectFile(projectContext(cwd, organizationId), request);
  if (result.ok) return result;
  if (result.isDirectory) return { kind: "directory" as const };
  if (result.isDirectory === false) throw new Error(result.error);
  // Older hosts reported a folder as a generic preview failure.
  const directory = await api.listDirectory(resolveWorkspaceFilePath(cwd, relativePath), true);
  if (!directory.error) return { kind: "directory" as const };
  throw new Error(result.error);
}

export const readEntry = checkoutQuery(
  (api, input: { cwd: string; relativePath: string; line?: number }, organizationId) =>
    readCheckoutEntry(api, input, organizationId, { index: 0, ...(input.line && { line: input.line }) }),
);

export const readTextPage = checkoutQuery(
  async (api, input: { cwd: string; path: string; index: number; revision: string }, organizationId) => {
    const { cwd, path, index, revision } = input;
    const result = await api.readProjectFile(projectContext(cwd, organizationId), {
      cwd,
      path,
      textPage: { index, revision },
    });
    if (!result.ok) throw new Error(result.error);
    if (result.kind !== "text" || result.page?.index !== index) {
      throw new Error("The host could not send this page.");
    }
    return result.contents;
  },
);

export type CheckoutAsset = { cwd: string; sessionId?: string; revision?: string | null } & (
  { path: string; assetId?: never; download?: boolean } | { assetId: string; path?: never; download?: never }
);

export async function signCheckoutAsset(
  api: Pick<HostApi, "assetCreateUrl">,
  { cwd, path, sessionId, download, assetId }: CheckoutAsset,
  organizationId: string | null,
  httpBaseUrl: string,
) {
  const context = projectContext(cwd, organizationId);
  if (sessionId) context.session.sessionId = sessionId;
  const signed = await api.assetCreateUrl(context, assetId !== undefined ? { assetId } : { path, ...(download && { download: true }) });
  return {
    url: new URL(signed.relativeUrl, new URL(httpBaseUrl).origin).toString(),
    expiresAt: signed.expiresAt,
    ...(signed.imageDimensions && { imageDimensions: signed.imageDimensions }),
  };
}

export const checkoutAssetUrl = checkoutQuery(
  async (api, input: { cwd: string; path: string }, organizationId, httpBaseUrl) =>
    (await signCheckoutAsset(api, input, organizationId, httpBaseUrl)).url,
);

export const checkoutMediaAsset = checkoutQuery(
  (api, input: CheckoutAsset, organizationId, httpBaseUrl) =>
    signCheckoutAsset(api, input, organizationId, httpBaseUrl),
);
