import { readUploadAttachmentId } from "./upload-attachment-id";
import type { EnvironmentId } from "@t3tools/contracts";
import { projectContext } from "@solus-mobile/features/conversation/lib/ipc-context";
import { appAtomRegistry } from "../state/atom-registry";
import { fileAccountScope, mobileHost } from "../state/mobile-host";

export async function attachmentUrl(hostId: EnvironmentId, id: string, name?: string) {
  const host = appAtomRegistry.get(mobileHost(hostId));
  const scope = appAtomRegistry.get(fileAccountScope);
  if (!host?.canReadFiles) return null;
  const uploaded = readUploadAttachmentId(id);
  const ctx = projectContext("~", scope.organizationId);
  if (uploaded) ctx.session.sessionId = uploaded.sessionId;
  const signed = uploaded
    ? await host.api.assetCreateUrl(ctx, { path: uploaded.path })
    : await host.api.assetCreateUrl(undefined, { assetId: id, name });
  if (
    appAtomRegistry.get(mobileHost(hostId)) !== host ||
    appAtomRegistry.get(fileAccountScope) !== scope
  )
    return null;
  return new URL(signed.relativeUrl, new URL(host.httpBaseUrl).origin).toString();
}
