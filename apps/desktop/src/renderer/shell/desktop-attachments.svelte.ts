import { tick } from "svelte";

import { connectionsStore, serversStore } from "@solus/workspace-ui/contexts";

import { toasts } from "@solus/workspace-ui/lib/toasts";

import type { DesignAnnotation as DesignAnnotationType } from "@solus/contracts/types";

import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
import { serverConnections } from "@solus/client-core/server-connections";
import { hostPolicy } from "@solus/client-core/host-policy";
import { unsupportedOnHost } from "@solus/client-core/host-capabilities";

import { localApi } from "@solus/client-core/local-api";

import { uploadLocalAttachments } from "@solus/workspace-ui/components/input/lib/attachment-upload";

import type { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
type DesktopAppCore = ReturnType<typeof createAppCore>;
import type { DesktopDialogs } from "./desktop-dialogs.svelte";

/** Resolve the destination once before native file selection or upload begins. */
export function attachmentTarget(
  session: DesktopAppCore["session"],
  tabId?: string,
) {
  const targetTabId = tabId ?? session.focusedChatTabId ?? session.activeTabId;
  const run = targetTabId
    ? session.runFor(targetTabId)
    : session.activeSession?.run;
  const serverId =
    run?.serverId ?? serverConnections.defaultServerId() ?? LOCAL_SERVER_ID;
  const ctx = targetTabId ? session.ctxFor(targetTabId) : session.ctx;
  return { targetTabId, serverId, ctx };
}

export function createDesktopAttachments(
  core: DesktopAppCore,
  ui: DesktopDialogs,
) {
  const { session } = core;
  const desktopHandlersAvailable = $derived(
    connectionsStore.desktopHandlersAvailable,
  );
  async function handleScreenshot(tabId?: string) {
    if (!desktopHandlersAvailable) return;
    const result = await serverConnections.localHostApi()?.takeScreenshot();
    if (!result) return;
    session.addAttachments([result], tabId);
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
      );
      session.addAttachments(uploaded, targetTabId);
    } catch (error) {
      toasts.error(
        error instanceof Error ? error.message : "Couldn't attach files",
      );
    }
  }

  async function handleDesignMode(tabId?: string) {
    if (!desktopHandlersAvailable) return;
    ui.designModeTargetTabId = tabId;
    const result = await serverConnections.localHostApi()?.enterDesignMode();
    if (!result) {
      ui.designModeTargetTabId = undefined;
      // Capture failed: tell main to restore opacity so we don't leave the window invisible.
      await serverConnections.localHostApi()?.designModeReady();
      await serverConnections.localHostApi()?.exitDesignMode();
      return;
    }
    // Pre-decode so the <img> paints on first frame. Without this the editor UI (temporarily
    // resized to the full work area for capture) can bleed through the transparent window
    // for a frame or two before the screenshot shows up.
    try {
      const img = new Image();
      img.src = result.dataUrl;
      await img.decode();
    } catch {}
    ui.designModeScreenshot = result.dataUrl;
    // tick() flushes Svelte DOM writes; double-rAF waits one frame past that for paint.
    await tick();
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    void serverConnections.localHostApi()?.designModeReady();
  }

  async function handleDesignConfirm(
    dataUrl: string,
    annotations: DesignAnnotationType[],
  ) {
    const attachment = await serverConnections
      .localHostApi()
      ?.submitDesignAnnotations({
        dataUrl,
        annotations,
      });
    if (attachment) {
      session.addAttachments([attachment], ui.designModeTargetTabId);
    }
    ui.designModeScreenshot = null;
    ui.designModeTargetTabId = undefined;
    await tick();
    await serverConnections.localHostApi()?.exitDesignMode();
  }

  async function handleDesignCancel() {
    ui.designModeScreenshot = null;
    ui.designModeTargetTabId = undefined;
    await tick();
    await serverConnections.localHostApi()?.exitDesignMode();
  }

  return {
    handleScreenshot,
    handleAttachFile,
    handleDesignMode,
    handleDesignConfirm,
    handleDesignCancel,
  };
}
