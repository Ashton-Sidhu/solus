import type { WorkspaceContext } from '@solus/workspace-ui/contexts/workspace/workspace.context.svelte'
import { serversStore } from '@solus/workspace-ui/contexts/connections/servers.store.svelte'
import { serverConnections } from '@solus/client-core/server-connections'
import { unsupportedOnHost } from '@solus/client-core/host-capabilities'
import { pickFiles } from '@solus/client-core/file-picker'
import { toasts } from '@solus/workspace-ui/lib/toasts'
import { uploadFileObjects } from '@solus/workspace-ui/components/input/lib/attachment-uploads.svelte'

export function createWebAttachments(session: WorkspaceContext) {
  async function attach(sourceId: string | undefined, files?: File[]) {
    const targetId = sourceId ?? session.focusedSourceId ?? session.activeTabId;
    const draft = targetId ? session.drafts.sessionDrafts.get(targetId) : undefined;
    const serverId = (targetId ? session.runFor(targetId)?.serverId : undefined)
      ?? serverConnections.defaultMachineId();
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
      // The shared upload path, so a video streams and its chip shows progress.
      const picked = files ?? await pickFiles();
      if (picked.length === 0) return;
      const attachments = await uploadFileObjects(api, ctx, serverId, picked);
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
