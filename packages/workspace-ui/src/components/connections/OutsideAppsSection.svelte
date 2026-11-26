<script lang="ts">
  /** "Use Solus in other apps" on Settings › Sharing & access (plans/035 §10). The steps
   *  are in one dialog (`OutsideAppsDialog`), which the palette and the host menu
   *  open too. Every person who uses the host sees it, and an app they approve
   *  acts as them. The apps that signed in are in the paired devices list, with
   *  their access and Revoke. */
  import { AppWindow as AppWindowIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import SettingsSection from "../settings/SettingsSection.svelte";
  import SettingsRow from "../settings/SettingsRow.svelte";
  import { outsideAppsDialog } from "./outside-apps/outside-apps-dialog.svelte";

  interface Props {
    serverId: string;
  }

  let { serverId }: Props = $props();
</script>

<SettingsSection label="Use Solus in other apps">
  <SettingsRow
    label="Connect an app"
    description="Claude, ChatGPT, Cursor, Claude Code, and other MCP apps can use this host's tools as you. You choose what each app can do, and you approve it."
  >
    {#snippet control()}
      <Button variant="outline" size="sm" onclick={() => outsideAppsDialog.open(serverId)}>
        <AppWindowIcon size={14} />
        Connect an app
      </Button>
    {/snippet}
  </SettingsRow>
</SettingsSection>
