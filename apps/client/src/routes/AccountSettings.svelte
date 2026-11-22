<script lang="ts">
  import { followAccountTheme } from "../lib/account-theme.svelte";
  import { onDestroy, onMount } from "svelte";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";
  import { Button } from "@solus/workspace-ui/components/ui/button";
  import { SettingsContext, setSettingsContext } from "@solus/workspace-ui/contexts/app/settings.context.svelte";
  import { accountStore } from "@solus/workspace-ui/contexts/account/account.store.svelte";
  import { accountSyncStore } from "@solus/workspace-ui/contexts/account/account-sync.store.svelte";
  import { agentProfileLocalStore } from "@solus/workspace-ui/contexts/seats/agent-profile-local.store.svelte";

  import AccountSettingsPage from "@solus/workspace-ui/components/settings/AccountSettingsPage.svelte";
  import { AgentContext, setAgentContext } from "@solus/workspace-ui/contexts/app/agent.context.svelte";
  import { agentProfileStore } from "@solus/workspace-ui/contexts";
  let { page }: { page: 'appearance' | 'agent-profile' } = $props();
  const settings = new SettingsContext();
  followAccountTheme(settings);
  setSettingsContext(settings);
  setAgentContext(new AgentContext(settings));
  agentProfileStore.attachLocalCopy(agentProfileLocalStore);
  onDestroy(accountSyncStore.start(settings.personal, agentProfileLocalStore));
  onDestroy(accountSyncStore.followAccount(accountStore));
  const sync = $derived(page === "appearance" ? accountSyncStore.settings.state : accountSyncStore.state);
  onMount(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => settings.setSystemTheme(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  });
</script>

<Tooltip.Provider>
  <AccountSettingsPage {page}>
    {#if sync === "offline" || sync === "error"}
      <div class="flex items-center gap-3">
        <p role="status">{sync === "offline" ? "Offline. Changes stay on this device until it reconnects." : "Solus could not sync these settings with your account."}</p>
        <Button variant="outline" size="sm" onclick={() => accountSyncStore.refresh()}>Try again</Button>
      </div>
    {/if}
    {#await (page === "appearance"
      ? import("@solus/workspace-ui/components/settings/SettingsTabAppearance.svelte")
      : import("@solus/workspace-ui/components/settings/SettingsTabAgentProfile.svelte"))}
      <p role="status">Loading settings…</p>
    {:then section}
      <section.default />
    {:catch}
      <p role="alert">Settings could not load. <a href={location.href} class="underline">Reload the page</a></p>
    {/await}
  </AccountSettingsPage>
</Tooltip.Provider>
