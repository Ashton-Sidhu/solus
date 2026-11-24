import type { HostApi } from "@solus/client-core/host-api";
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
) {
  const result = await api.readProjectFile(projectContext(cwd, organizationId), {
    cwd,
    path: relativePath,
  });
  if (result.ok) return result;
  // A path opened from a message or markdown link can also name a folder.
  const directory = await api.listDirectory(resolveWorkspaceFilePath(cwd, relativePath), true);
  if (!directory.error) return { kind: "directory" as const };
  throw new Error(result.error);
}

export const readEntry = checkoutQuery(readCheckoutEntry);

export async function signCheckoutAsset(
  api: Pick<HostApi, "assetCreateUrl">,
  { cwd, path }: { cwd: string; path: string },
  organizationId: string | null,
  httpBaseUrl: string,
) {
  const signed = await api.assetCreateUrl(projectContext(cwd, organizationId), { path });
  return {
    url: new URL(signed.relativeUrl, new URL(httpBaseUrl).origin).toString(),
    expiresAt: signed.expiresAt,
  };
}

export const checkoutAssetUrl = checkoutQuery(
  async (api, input: { cwd: string; path: string }, organizationId, httpBaseUrl) =>
    (await signCheckoutAsset(api, input, organizationId, httpBaseUrl)).url,
);

export const checkoutMediaAsset = checkoutQuery(
  (api, input: { cwd: string; path: string; revision?: string | null }, organizationId, httpBaseUrl) =>
    signCheckoutAsset(api, input, organizationId, httpBaseUrl),
);
