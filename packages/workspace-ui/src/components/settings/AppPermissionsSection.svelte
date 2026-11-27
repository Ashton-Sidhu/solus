<script lang="ts">
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { localApi } from "@solus/client-core/local-api";
  import type { AppDesktopPermission, AppPermissionsView } from "@solus/contracts/app-desktop";
  import { appPermissionsStore } from "../../contexts/apps/app-permissions.store.svelte";
  import { toasts } from "../../lib/toasts";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import { APP_PERMISSION_CHOICES, appPermissionRows, appPermissionsSummary, desktopOsOf, type AppPermissionChoice } from "./lib/app-permissions";

  /** The desktop capabilities that each app may use in its own window on this
   *  computer (docs/plans/app-desktop-capabilities.md §2). Desktop only: on web
   *  and mobile an app has no window of its own. */
  let { visible }: { visible: boolean } = $props();

  appPermissionsStore.start();
  const os = desktopOsOf(localApi.getPlatform?.());

  async function choose(app: AppPermissionsView, permission: AppDesktopPermission, state: AppPermissionChoice) {
    try {
      await appPermissionsStore.change({ host: app.host, appId: app.appId, permission, state });
    } catch (error) {
      toasts.error("The permission did not change.", { description: error instanceof Error ? error.message : String(error) });
    }
  }
</script>

<SettingsSection {...settingsDefinitions["general.section-app-permissions"]} visible={visible && appPermissionsStore.isAvailable}>
  {#if appPermissionsStore.apps.length === 0}
    <SettingsRow label="No app has asked yet" description="An app asks the first time it uses a capability in its own window." />
  {:else}
    {#each appPermissionsStore.apps as app (`${app.host}/${app.appId}`)}
      <SettingsRow label={app.name || "Unnamed app"} description={appPermissionsSummary(app, os)} testId="app-permissions-row">
        {#snippet body()}
          <ul class="mt-3 flex flex-col gap-2">
            {#each appPermissionRows(app, os) as row (row.permission)}
              <li class="flex min-h-8 items-center justify-between gap-4 text-sm text-foreground">
                <span class="min-w-0 truncate">{row.label}</span>
                <SettingsSelect
                  compact
                  options={APP_PERMISSION_CHOICES}
                  value={row.choice}
                  ariaLabel="{row.label} for {app.name}"
                  onSelect={(state) => void choose(app, row.permission, state)}
                />
              </li>
            {/each}
          </ul>
        {/snippet}
      </SettingsRow>
    {/each}
  {/if}
</SettingsSection>
