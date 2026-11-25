import { readUploadAttachmentId } from "../solus/upload-attachment-id";
import { attachmentUrl } from "../solus/attachment-resource";
import { checkoutMediaAsset, signCheckoutAsset } from "../solus/checkout-files";
import { mobileHost, fileAccountScope } from "./mobile-host";
import { mediaTypeFor } from "@solus/contracts/media-types";
import { useAtomMount, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import {
  assetUrlStateFromResult,
  blockedAssetUrlState,
  createAssetEnvironmentAtoms,
  EMPTY_ASSET_URL_ATOM,
  makeRevisionedAssetUrlFamily,
} from "@t3tools/client-runtime/state/assets";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { msg, useMessages } from "gt-react-native";
import { m } from "../i18n/messages";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { videoMimeType } from "@t3tools/shared/video";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom, AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { appAtomRegistry } from "./atom-registry";
import { environmentSession, usePreparedConnection } from "./session";
import { useEnvironmentPresentation } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomQueryRunner } from "./use-atom-query-runner";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

export { projectFaviconUrlAtom } from "./project-favicons";

const revisionedAssetUrl = makeRevisionedAssetUrlFamily(assetEnvironment.createUrl);
const noHost = Atom.make(null);
const emptyHostMediaState = Atom.make<AssetUrlState | null>(null).pipe(
  Atom.withLabel("host-media-state:none"),
);

function hostMediaPath(resource: AssetResource | null) {
  if (resource?._tag === "attachment") {
    const upload = readUploadAttachmentId(resource.attachmentId);
    return upload ? { cwd: "~", ...upload } : null;
  }
  if (resource?._tag !== "media-file" && resource?._tag !== "draft-workspace-file") return null;
  if (
    mediaTypeFor(resource.path)?.kind !== "image" &&
    !videoMimeType({ name: resource.path, mimeType: "" })
  ) {
    return null;
  }
  // Markdown resolves thread media links against the workspace before building the resource.
  return { cwd: resource._tag === "draft-workspace-file" ? resource.cwd : "~", path: resource.path };
}

const hostMediaState = Atom.family(
  ({
    environmentId,
    ...input
  }: {
    environmentId: EnvironmentId;
    cwd: string;
    path: string;
    sessionId?: string;
    revision?: string | null;
  }) =>
    Atom.make((get): AssetUrlState => {
      const host = get(mobileHost(environmentId));
      if (!host) return { _tag: "Failure", reason: "disconnected" };
      if (!host.canReadFiles) return { _tag: "Failure", reason: "missing-file-access" };
      const accountKey = get(fileAccountScope).key;
      const signed = get(checkoutMediaAsset({ environmentId, accountKey, input }));
      if (signed.waiting || signed._tag === "Initial") return { _tag: "Loading" };
      if (signed._tag === "Failure") return { _tag: "Failure", reason: "failed" };
      return { _tag: "Success", ...signed.value };
    }).pipe(Atom.withLabel("host-media-state")),
);

export function useAssetConnectionAvailable(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): boolean {
  const isHostMedia = hostMediaPath(resource) !== null;
  const host = useAtomValue(isHostMedia && environmentId ? mobileHost(environmentId) : noHost);
  const connection = usePreparedConnection(isHostMedia ? null : environmentId);
  return isHostMedia ? host !== null : connection._tag === "Some";
}

/**
 * Pass `revision` for a host file whose bytes can change under the same path; each new
 * revision re-mints the URL so the image reloads.
 */
export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision?: string | null,
): AssetUrlState {
  const media = hostMediaPath(resource);
  const hostState = useAtomValue(
    media && environmentId
      ? hostMediaState({ environmentId, ...media, ...(revision === undefined ? {} : { revision }) })
      : emptyHostMediaState,
  );
  const t3EnvironmentId = media ? null : environmentId;
  const fileAccessSession = useEnvironmentQuery(
    t3EnvironmentId === null ? null : environmentSession.sessionStateAtom(t3EnvironmentId),
  );
  const messages = useMessages();
  const fileEnvironment = useEnvironmentPresentation(t3EnvironmentId);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    messages,
  );
  const blocked = blockedAssetUrlState(resource, fileAccess);
  const preparedConnection = usePreparedConnection(t3EnvironmentId);
  const connectionPhase = fileEnvironment.presentation?.connection.phase ?? "available";
  const result = useAtomValue(
    blocked !== null || t3EnvironmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : revision === undefined
        ? assetEnvironment.createUrl({ environmentId: t3EnvironmentId, input: { resource } })
        : revisionedAssetUrl({ environmentId: t3EnvironmentId, input: { resource }, revision }),
  );
  const shared =
    blocked ??
    assetUrlStateFromResult(
      result,
      preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
    );
  return (
    hostState ??
    deriveAssetUrlState({
      connectionPhase,
      shared: shared._tag === "Failure" && result.waiting ? { _tag: "Loading" } : shared,
    })
  );
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const media = hostMediaPath(resource);
  const connection = usePreparedConnection(media ? null : environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return async () => {
    if (media && environmentId && resource?._tag === "attachment") {
      const scope = appAtomRegistry.get(fileAccountScope);
      const host = appAtomRegistry.get(mobileHost(environmentId));
      const atom = checkoutMediaAsset({ environmentId, accountKey: scope.key, input: media });
      const result = await executeAtomQuery(appAtomRegistry, atom, { refresh: true, reportFailure: false });
      return result._tag === "Success" && appAtomRegistry.get(fileAccountScope) === scope &&
        appAtomRegistry.get(mobileHost(environmentId)) === host ? result.value.url : null;
    }
    if (media && environmentId && resource)
      return refreshAssetUrl(environmentId, resource).catch(() => null);
    if (environmentId && resource?._tag === "attachment")
      return attachmentUrl(environmentId, resource.attachmentId, resource.fileName);
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const state = assetUrlStateFromResult(
      await createUrl({ environmentId, input: { resource } }),
      httpBaseUrl,
    );
    return state._tag === "Success" ? state.url : null;
  };
}

/**
 * {@link useRefreshAssetUrl} for async tasks that resolve several resources at once. Resolves
 * null without a connection and rejects with the server's error when it refuses the URL.
 */
export async function refreshAssetUrl(
  environmentId: EnvironmentId,
  resource: AssetResource,
  signal?: AbortSignal,
): Promise<string | null> {
  if (resource._tag === "attachment")
    return attachmentUrl(environmentId, resource.attachmentId, resource.fileName);
  const media = hostMediaPath(resource);
  if (media) {
    const hostAtom = mobileHost(environmentId);
    const release = appAtomRegistry.mount(hostAtom);
    try {
      const host = appAtomRegistry.get(hostAtom);
      const scope = appAtomRegistry.get(fileAccountScope);
      if (!host?.canReadFiles || signal?.aborted) return null;
      const signed = await signCheckoutAsset(host.api, media, scope.organizationId, host.httpBaseUrl);
      if (
        signal?.aborted ||
        appAtomRegistry.get(hostAtom) !== host ||
        appAtomRegistry.get(fileAccountScope) !== scope
      ) return null;
      return signed.url;
    } finally {
      release();
    }
  }
  const connectionAtom = environmentSession.preparedConnectionValueAtom(environmentId);
  if (appAtomRegistry.get(connectionAtom)._tag === "None") return null;
  const atom = assetEnvironment.createUrl({ environmentId, input: { resource } });
  const result = await executeAtomQuery(appAtomRegistry, atom, {
    label: atom.label?.[0] ?? "asset url",
    refresh: true,
    reportFailure: false,
    ...(signal ? { signal } : {}),
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  // A route can change while the query runs; resolve against the connection now current.
  const connection = appAtomRegistry.get(connectionAtom);
  if (connection._tag === "None") return null;
  const state = assetUrlStateFromResult(result, connection.value.httpBaseUrl);
  return state._tag === "Success" ? state.url : null;
}

export interface AuthorizedAssetUrl {
  readonly url: string;
  readonly authorizedAt: number;
}

interface FreshAssetUrlKey {
  readonly account: string;
  readonly generation?: number;
  readonly environmentId: EnvironmentId | null;
  readonly resource: AssetResource;
  /** A reconnect changes the base URL, and any URL minted against the old one is unusable. */
  readonly httpBaseUrl: string | null;
  /** Bumped by Retry so a file replaced on disk is reauthorized. */
  readonly revision: number;
}

class AssetUrlUnavailableError extends Schema.TaggedError<AssetUrlUnavailableError>()(
  "AssetUrlUnavailableError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
const freshAssetUrlFamily = Atom.family((key: FreshAssetUrlKey) =>
  Atom.make(
    Effect.tryPromise({
      try: async (signal) =>
        key.environmentId === null
          ? null
          : await refreshAssetUrl(key.environmentId, key.resource, signal),
      catch: (cause) =>
        new AssetUrlUnavailableError({
          message: errorDisplayMessage(cause, m) ?? m(msg("The attachment is unavailable.")),
          cause,
        }),
    }).pipe(
      Effect.flatMap((url) =>
        url
          ? Effect.map(
              Clock.currentTimeMillis,
              (authorizedAt): AuthorizedAssetUrl => ({
                url,
                authorizedAt,
              }),
            )
          : Effect.fail(
              new AssetUrlUnavailableError({
                message: m(msg("Reconnect to this environment and try again.")),
              }),
            ),
      ),
    ),
  ).pipe(Atom.withLabel("fresh-asset-url")),
);

const noFreshAssetUrl = Atom.make(
  AsyncResult.initial<AuthorizedAssetUrl, AssetUrlUnavailableError>(),
).pipe(Atom.withLabel("fresh-asset-url:none"));
const noSessionGeneration = Atom.make(0);

/**
 * A signed URL minted when the reader mounts, not a cached one: cached links can
 * expire while the client is suspended.
 */
export function useFreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  revision: number,
): AsyncResult.AsyncResult<AuthorizedAssetUrl, Error> {
  const usesSolusHost = resource?._tag === "attachment" || hostMediaPath(resource) !== null;
  const connection = usePreparedConnection(usesSolusHost ? null : environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const host = useAtomValue(
    usesSolusHost && environmentId ? mobileHost(environmentId) : noHost,
  );
  const account = useAtomValue(fileAccountScope);
  const atom =
    resource === null
      ? noFreshAssetUrl
      : freshAssetUrlFamily({
          environmentId,
          resource,
          httpBaseUrl: usesSolusHost ? (host?.canReadFiles ? host.httpBaseUrl : null) : httpBaseUrl,
          revision,
          account: account.key,
          generation: host?.generation,
        });
  // Minting fails at once while the environment is unreachable; mint again once a new session is
  // up instead of keeping the error until Retry.
  const sessionGeneration =
    environmentId === null
      ? noSessionGeneration
      : environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    if (AsyncResult.isFailure(appAtomRegistry.get(atom))) appAtomRegistry.refresh(atom);
  });
  return useAtomValue(atom);
}
