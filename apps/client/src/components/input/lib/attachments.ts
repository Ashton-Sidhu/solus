import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import { serversStore } from '@solus/workspace-ui/contexts/connections/servers.store.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { unsupportedOnHost } from '@solus/client-core/host-capabilities'
import { toasts } from '@solus/workspace-ui/lib/toasts'

export function createWebAttachments(session: WorkspaceContext) {
  async function attach(sourceId: string | undefined, files?: File[]) {
    const targetId = sourceId ?? session.focusedSourceId ?? session.activeTabId;
    const draft = targetId ? session.sessionDrafts.get(targetId) : undefined;
    const serverId = (targetId ? session.runFor(targetId)?.serverId : undefined)
      ?? serverConnections.defaultServerId();
    if (!serverId) return;
    // Capture the host and prompt before a picker or upload can yield to navigation.
    const api = serverConnections.apiFor(serverId);
    const ctx = targetId ? session.ctxFor(targetId) : session.ctx;
    try {
      const capabilities = await serverConnections.capabilitiesFor(serverId);
      if (capabilities.attachUpload !== true) {
        const hostLabel = serversStore.hostFor(serverId)?.label
          ?? serverConnections.connectionFor(serverId)?.target.label ?? 'this host';
        toasts.info(unsupportedOnHost('File attachments', hostLabel));
        return;
      }
      const attachments = files ? await api.uploadFiles(files, ctx) : await api.attachFiles(ctx);
      if (!attachments) {
        if (files) toasts.error("Couldn't attach files");
        return;
      }
      for (const attachment of attachments) {
        if (files || attachment.hostPath) attachment.hostServerId = serverId;
      }
      if (draft) draft.prompt.attachments.push(...attachments);
      else session.addAttachments(attachments, targetId);
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : "Couldn't attach files");
    }
  }

  return {
    attachFile: (sourceId?: string) => attach(sourceId),
    attachFiles: (files: File[], sourceId?: string) => files.length ? attach(sourceId, files) : Promise.resolve(),
  };
}
