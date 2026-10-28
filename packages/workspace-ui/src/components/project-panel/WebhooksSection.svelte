<script lang="ts">
  /** The webhooks of this project (docs/plans/webhooks.md §4), with their state
   *  and last delivery. A row opens the webhook in Settings. */
  import { Webhook as WebhookIcon } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import { relativeTime } from "../../lib/relative-time";
  import PanelSection from "./PanelSection.svelte";
  import MenuRow from "./MenuRow.svelte";
  import {
    EMPTY_WEBHOOKS_VIEW,
    isFailingOutcome,
    outcomeLabel,
    serializeWebhooksView,
    webhookState,
    webhookStateLabel,
    type WebhookRow,
  } from "../webhooks/lib/webhooks-view";

  interface Props {
    rows: WebhookRow[];
    collapsed: boolean;
    onToggle: () => void;
    onResizePointerDown?: (event: PointerEvent) => void;
  }
  let { rows, collapsed, onToggle, onResizePointerDown }: Props = $props();

  const session = getWorkspaceContext();

  function badgeFor(row: WebhookRow): string {
    const state = webhookState(row.webhook);
    if (state !== "active") return webhookStateLabel(state);
    const last = row.webhook.lastDelivery;
    return last ? `${outcomeLabel(last.outcome)} · ${relativeTime(last.at)}` : "No deliveries";
  }

  function open(row: WebhookRow) {
    const view = serializeWebhooksView({ ...EMPTY_WEBHOOKS_VIEW, open: { kind: "webhook", serverId: row.serverId, webhookId: row.webhook.id } });
    session.showSettings("webhooks", "click", view);
  }
</script>

<PanelSection title="Webhooks" {collapsed} {onToggle} {onResizePointerDown}>
  {#each rows as row (`${row.serverId}\n${row.webhook.id}`)}
    {@const last = row.webhook.lastDelivery}
    <MenuRow
      item={{
        key: row.webhook.id,
        label: row.webhook.name,
        icon: WebhookIcon,
        phase: "idle",
        badge: badgeFor(row),
        iconTone: last && isFailingOutcome(last.outcome) ? "danger" : undefined,
        tooltip: row.webhook.verification.scheme === "none" ? "No verification. Anyone with this URL can start agent work." : undefined,
      }}
      onActivate={() => open(row)}
    />
  {/each}
</PanelSection>
