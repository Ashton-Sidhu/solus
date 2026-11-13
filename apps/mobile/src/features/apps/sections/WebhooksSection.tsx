import { useCallback } from "react";

import type { HostApi } from "@solus/client-core/host-api";

import { AppDetailRow, CopyPill, LoadedSection } from "../app-rows";
import { webhookLines } from "../apps";
import { useAppRead } from "../use-app";
import type { AppSectionProps } from "./section-props";

/**
 * Webhooks (docs/plans/apps.md §8.2, §9.2): the webhooks the app declares.
 * The owner copies the URL and the signing secret into the other service.
 */
export function WebhooksSection({ hostId, appId, connected }: AppSectionProps) {
  const readWebhooks = useCallback((api: HostApi) => api.appWebhooks({ appId }), [appId]);
  const webhooks = useAppRead(hostId, appId, "webhooks", readWebhooks);
  const hasWebhooks = webhooks.state.kind === "loaded" && webhooks.state.value.length > 0;

  return (
    <LoadedSection
      title="Webhooks"
      read={webhooks.state}
      connected={connected}
      subject="The webhooks"
      empty="This app declares no webhook."
      note={hasWebhooks ? "The URL and the signing secret are credentials. Give them only to the service that sends the requests." : undefined}
      onRetry={webhooks.reload}
    >
      {(items) =>
        items.map((webhook, index) => (
          <AppDetailRow
            key={webhook.name}
            first={index === 0}
            title={webhook.name}
            trailing={webhook.webhookId === null ? "Not made" : webhook.enabled ? "On" : "Paused"}
            trailingTone={webhook.webhookId === null ? "danger" : "muted"}
            lines={webhookLines(webhook)}
          >
            {webhook.url !== null ? <CopyPill label="Copy URL" target="webhook URL" value={webhook.url} /> : null}
            {webhook.secret !== null ? <CopyPill label="Copy signing secret" target="signing secret" value={webhook.secret} /> : null}
          </AppDetailRow>
        ))
      }
    </LoadedSection>
  );
}
