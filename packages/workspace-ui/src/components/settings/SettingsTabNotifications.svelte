<script lang="ts">
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Switch } from "../ui/switch";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import {
    APP_NOTICE_ROWS,
    DELIVERY_SITUATIONS,
    NOTIFICATION_CHANNEL_ROWS,
    SESSION_EVENT_ROWS,
    notificationRowMatches,
  } from "./lib/notification-settings";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const settings = getSettingsContext();

  const channelRows = $derived(
    NOTIFICATION_CHANNEL_ROWS.filter((row) => notificationRowMatches(row, searchQuery)),
  );
  const situations = $derived(
    DELIVERY_SITUATIONS.map((situation) => ({
      ...situation,
      rows: channelRows.filter((row) => row.situation === situation.id),
    })),
  );
  const sessionEventRows = $derived(
    SESSION_EVENT_ROWS.filter((row) => notificationRowMatches(row, searchQuery)),
  );
  const appNoticeRows = $derived(
    APP_NOTICE_ROWS.filter((row) => notificationRowMatches(row, searchQuery)),
  );
  const noChannelOn = $derived(
    !settings.notifications.channels.sound &&
      !settings.notifications.channels.toast &&
      !settings.notifications.channels.system,
  );
  const anyVisible = $derived(
    channelRows.length > 0 || sessionEventRows.length > 0 || appNoticeRows.length > 0,
  );
</script>

{#each situations as situation (situation.id)}
  <SettingsSection
    label={situation.label}
    description={situation.description}
    visible={situation.rows.length > 0}
  >
    {#each situation.rows as row (row.id)}
      <SettingsRow label={row.label} description={row.description}>
        {#snippet control()}
          <Switch
            checked={settings.notifications.channels[row.id]}
            onCheckedChange={(enabled) => {
              settings.setNotificationChannel(row.id, enabled);
              requestInputFocus();
            }}
            aria-label={row.label}
          />
        {/snippet}
      </SettingsRow>
    {/each}
  </SettingsSection>
{/each}

<SettingsSection
  label="Session events"
  description={noChannelOn
    ? "All channels are off. Session events do not notify you."
    : "Sound plays for all events. Toasts and alerts: approvals, questions, failures, finished turns."}
  visible={sessionEventRows.length > 0}
>
  {#each sessionEventRows as row (row.id)}
    <SettingsRow label={row.label} description={row.description}>
      {#snippet control()}
        <Switch
          checked={settings.notifications.events[row.id]}
          onCheckedChange={(enabled) => {
            settings.setNotificationEvent(row.id, enabled);
            requestInputFocus();
          }}
          aria-label={row.label}
        />
      {/snippet}
    </SettingsRow>
  {/each}
</SettingsSection>

<SettingsSection
  label="App notices"
  description="Workspace events. Always an in-app toast."
  visible={appNoticeRows.length > 0}
>
  {#each appNoticeRows as row (row.id)}
    <SettingsRow label={row.label} description={row.description}>
      {#snippet control()}
        <Switch
          checked={settings.notifications.events[row.id]}
          onCheckedChange={(enabled) => {
            settings.setNotificationEvent(row.id, enabled);
            requestInputFocus();
          }}
          aria-label={row.label}
        />
      {/snippet}
    </SettingsRow>
  {/each}
</SettingsSection>

{#if !anyVisible}
  <div class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary)">
    No settings match your search
  </div>
{/if}
