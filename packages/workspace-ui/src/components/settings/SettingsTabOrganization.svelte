<script lang="ts">
  import { organizationSearchWords as searchWords } from "./lib/settings-search-data";
  /** Organization: what an organization holds in Solus Cloud for its members.
   *  What its work may do — Insights, limits, locked settings — is its policy,
   *  on Settings → Policy (plans/030 §7). Hosts, packages, and the setup script
   *  stay in the Solus console. */
  import { accountStore, getWorkspaceContext, serversStore } from "../../contexts";
  import { Button } from "../ui/button";
  import SettingsCloudProjects from "./SettingsCloudProjects.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";

  let { searchQuery = "" }: { searchQuery?: string } = $props();

  const session = getWorkspaceContext();
  const account = $derived(accountStore.state);
  const origin = $derived(account.kind === "signed-in" ? account.consoleUrl : null);
  const organizations = $derived(serversStore.organizations);
  const consoleHost = $derived(origin?.replace(/^https?:\/\//, "") ?? "the Solus console");

  const matches = $derived(!searchQuery || searchWords.some((word) => word.includes(searchQuery.toLowerCase())));
</script>

{#if matches}
  {#if account.kind !== "signed-in"}
    <p class="text-workspace-chrome text-muted-foreground" role="status">Sign in to Solus to see your organizations.</p>
  {:else if organizations.length === 0}
    <p class="text-workspace-chrome text-muted-foreground" role="status">You are not a member of an organization.</p>
  {:else}
    <SettingsSection label="Organization">
      <SettingsRow label="Policy" description="Insights, limits, and locked settings of each organization's work.">
        {#snippet control()}
          <Button variant="outline" size="sm" onclick={() => session.showSettings("policy", "click")}>Open Policy</Button>
        {/snippet}
      </SettingsRow>
    </SettingsSection>
    <p class="text-xs text-muted-foreground">
      Hosts, default packages, and the setup script of each organization are in the Solus console at {consoleHost}.
    </p>
  {/if}
{/if}

<SettingsCloudProjects />
