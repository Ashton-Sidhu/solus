import { hosts, serversStore } from "@solus/workspace-ui/contexts";

import { toasts } from "@solus/workspace-ui/lib/toasts";

import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
import { serverConnections } from "@solus/client-core/server-connections";
import { hostPolicy } from "@solus/client-core/host-policy";
import { unsupportedOnHost } from "@solus/client-core/host-capabilities";

import { desktopCaptureSupport } from "@solus/client-core/desktop-capture";

import { localApi } from "@solus/client-core/local-api";

import { uploadLocalAttachments } from "@solus/workspace-ui/components/input/lib/attachment-uploads.svelte";

import type { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
import { runHost } from "@solus/workspace-ui/contexts/workspace/run-location";
type DesktopAppCore = ReturnType<typeof createAppCore>;

/** Resolve the destination once before native file selection or upload begins.
 *  The target is a tab or a draft: a draft composes into its own prompt. */
export function attachmentTarget(
  session: DesktopAppCore["session"],
  tabId?: string,
) {
  const targetTabId = tabId ?? session.focusedSourceId ?? session.activeTabId;
  const run = targetTabId
    ? session.runFor(targetTabId)
    : session.activeSession?.run;
  const serverId =
    runHost(run) ?? serverConnections.runOnHostId() ?? LOCAL_SERVER_ID;
  const ctx = targetTabId ? session.ctxFor(targetTabId) : session.ctx;
  return { targetTabId, serverId, ctx };
}

/** A video picked on this machine, as a Blob. The local video protocol streams
 *  it from disk; the IPC byte read would copy it as base64 and caps at 10 MB. */
async function readLocalVideo(path: string): Promise<Blob> {
  const response = await fetch(`solus-local-video://local/?p=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error("Couldn't read the video.");
  return response.blob();
}

export function createDesktopAttachments(
  core: DesktopAppCore,
) {
  const { session } = core;
  const desktopHandlersAvailable = $derived(
    (hosts.device?.hasDesktopHandlers ?? false),
  );
  const captureSupport = desktopCaptureSupport(localApi.getPlatform());
  async function handleScreenshot(tabId?: string) {
    if (!desktopHandlersAvailable || !captureSupport.screenshot) return;
    const { targetTabId, serverId, ctx } = attachmentTarget(session, tabId);
    const targetStillExists = () => {
      const current = attachmentTarget(session, targetTabId);
      if (current.serverId !== serverId) return false;
      return targetTabId ? !!session.runFor(targetTabId) : current.targetTabId === undefined;
    };
    try {
      const targetApi = serverConnections.apiFor(serverId);
      const capabilities = await serverConnections.capabilitiesFor(serverId);
      if (capabilities.attachUpload !== true) {
        toasts.info("This host cannot receive screenshots.");
        return;
      }
      const captureApi = serverConnections.localHostApi();
      if (!captureApi) throw new Error("The local desktop is not connected. Try again after it reconnects.");
      const result = await captureApi.takeScreenshot();
      if (!result) return;
      if (!targetStillExists()) return;
      const attachments = await uploadLocalAttachments(targetApi, ctx, serverId, [result],
            (path, mime) => localApi.readAttachmentBytes(path, mime), readLocalVideo);
      if (!targetStillExists()) return;
      session.addAttachments(attachments, targetTabId);
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : "Could not take a screenshot.");
    }
  }

  async function handleAttachFile(tabId?: string) {
    const { targetTabId, serverId, ctx } = attachmentTarget(session, tabId);
    const targetApi = serverConnections.apiFor(serverId);
    try {
      const capabilities = await serverConnections.capabilitiesFor(serverId);
      if (capabilities.attachUpload !== true) {
        const hostLabel =
          serversStore.hostFor(serverId)?.label ??
          serverConnections.connectionFor(serverId)?.target.label ??
          "this host";
        toasts.info(unsupportedOnHost("File attachments", hostLabel));
        return;
      }
      if (hostPolicy.isClientMachine(serverId)) {
        const files = await targetApi.attachFiles(ctx);
        if (files?.length) session.addAttachments(files, targetTabId);
        return;
      }
      const localFiles = await serverConnections
        .localHostApi()
        ?.attachFiles(ctx);
      if (!localFiles?.length) return;
      const uploaded = await uploadLocalAttachments(
        targetApi,
        ctx,
        serverId,
        localFiles,
        (path, mime) => localApi.readAttachmentBytes(path, mime),
        readLocalVideo,
      );
      session.addAttachments(uploaded, targetTabId);
    } catch (error) {
      toasts.error(
        error instanceof Error ? error.message : "Couldn't attach files",
      );
    }
  }

  return {
    handleScreenshot,
    handleAttachFile,
  };
}
