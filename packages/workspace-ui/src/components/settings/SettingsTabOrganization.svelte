<script lang="ts">
  /** Organization: what an organization is and where its members run work, for a
   *  signed-in person. Every member reads the same page; an owner also renames the
   *  organization and changes its host rules, and finds the owner pages of the
   *  Solus console here. Solus Cloud checks the role again on each write.
   *  What work may do — Insights, limits, locked settings — is the organization's
   *  policy, on Settings → Policy (plans/030 §7). Invitations, roles, and removal
   *  stay in the console. */
  import { untrack } from "svelte";
  import { localApi } from "@solus/client-core/local-api";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { accountStore, getWorkspaceContext, serversStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import { Textarea } from "../ui/textarea";
  import { consolePageUrl } from "../session/lib/account-menu";
  import { organizationSearchWords as searchWords } from "./lib/settings-search-data";
  import {
    canManageOrganization,
    changedHostRules,
    organizationConsoleUrl,
    packagesFromText,
    type OrganizationConsolePage,
  } from "./organization/lib/organization-settings";
  import { organizationSettingsStore as store } from "./organization/organization-settings.store.svelte";
  import SettingsCloudProjects from "./SettingsCloudProjects.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";

  let { searchQuery = "" }: { searchQuery?: string } = $props();

  const session = getWorkspaceContext();
  const account = $derived(accountStore.state);
  const origin = $derived(account.kind === "signed-in" ? account.consoleUrl : null);
  const organizations = $derived(serversStore.organizations);
  const organizationId = $derived(
    organizations.find((entry) => entry.organizationId === store.selectedOrganizationId)?.organizationId ??
      organizations.find((entry) => entry.isActive)?.organizationId ??
      organizations[0]?.organizationId ??
      null,
  );
  const view = $derived(origin && organizationId ? store.viewFor(origin, organizationId) : undefined);
  const ready = $derived(view?.status === "ready" ? view : null);
  const isOwner = $derived(ready ? canManageOrganization(ready.settings) : false);

  const matches = $derived(!searchQuery || searchWords.some((word) => word.includes(searchQuery.toLowerCase())));

  // Read each organization when it is shown; a later visit reads it again.
  $effect(() => {
    if (!origin || !organizationId) return;
    untrack(() => void store.load(origin, organizationId));
  });

  // Drafts of the typed fields. Each starts from what Solus Cloud holds and saves on leave or Enter.
  let nameDraft = $state<string | null>(null);
  let packagesDraft = $state<string | null>(null);
  let scriptDraft = $state<string | null>(null);

  function openConsole(page: OrganizationConsolePage) {
    if (origin && organizationId) void localApi.openExternal(organizationConsoleUrl(origin, organizationId, page));
  }

  async function saveName() {
    if (!origin || !organizationId || nameDraft === null) return;
    if (await store.rename(origin, organizationId, nameDraft)) nameDraft = null;
  }

  async function saveRules(change: Parameters<typeof changedHostRules>[1]) {
    if (!origin || !organizationId || !ready) return false;
    return store.saveHostRules(origin, organizationId, changedHostRules(ready.settings.hostRules, change));
  }

  async function savePackages() {
    if (packagesDraft === null) return;
    if (await saveRules({ defaultPackages: packagesFromText(packagesDraft) })) packagesDraft = null;
  }

  async function saveScript() {
    if (scriptDraft === null) return;
    if (await saveRules({ defaultSetupScript: scriptDraft })) scriptDraft = null;
  }

  function selectOrganization(id: string) {
    store.selectedOrganizationId = id;
    nameDraft = packagesDraft = scriptDraft = null;
    requestInputFocus();
  }
</script>

{#if matches}
  {#if account.kind !== "signed-in"}
    <p class="text-workspace-chrome text-muted-foreground" role="status">Sign in to Solus to see your organizations.</p>
  {:else if organizations.length === 0}
    <SettingsSection {...settingsDefinitions["organization.section-organization"]}>
      <SettingsRow label="No organization" description="You are not a member of an organization. Create one, or accept an invitation, on Solus Cloud.">
        {#snippet control()}
          <Button variant="outline" size="sm" onclick={() => void localApi.openExternal(consolePageUrl(account.consoleUrl, "organizations"))}>Open Solus Cloud</Button>
        {/snippet}
      </SettingsRow>
    </SettingsSection>
  {:else}
    <SettingsSection
      {...settingsDefinitions["organization.section-organization"]}
      description={ready ? (isOwner ? "You are an owner. You can change these settings." : "You are a member. Only an owner can change these settings.") : undefined}
    >
      {#if organizations.length > 1}
        <SettingsRow label="Organization" description="The organization these settings are for. It does not change the organization of this window.">
          {#snippet control()}
            <SettingsSelect
              options={organizations.map((entry) => ({ value: entry.organizationId, label: entry.name }))}
              value={organizationId ?? ""}
              onSelect={selectOrganization}
              ariaLabel="Organization"
            />
          {/snippet}
        </SettingsRow>
      {/if}
      {#if ready}
        <SettingsRow {...settingsDefinitions["organization.name"]}>
          {#snippet control()}
            {#if isOwner}
              <Input
                class="w-56"
                aria-label="Organization name"
                maxlength={80}
                dictation={false}
                disabled={ready.isSaving}
                value={nameDraft ?? ready.settings.name}
                oninput={(event) => (nameDraft = event.currentTarget.value)}
                onblur={() => void saveName()}
                onkeydown={(event) => { if (event.key === "Enter") void saveName(); }}
              />
            {:else}
              <span class="truncate text-foreground">{ready.settings.name}</span>
            {/if}
          {/snippet}
        </SettingsRow>
        <SettingsRow {...settingsDefinitions["organization.url"]}>
          {#snippet control()}
            <span class="font-mono text-xs text-(--solus-text-secondary)">{ready.settings.slug}</span>
          {/snippet}
        </SettingsRow>
        <SettingsRow {...settingsDefinitions["organization.role"]}>
          {#snippet control()}
            <span class="text-foreground">{isOwner ? "Owner" : "Member"}</span>
          {/snippet}
        </SettingsRow>
      {/if}
    </SettingsSection>

    {#if !view || view.status === "loading"}
      <p class="text-workspace-chrome text-muted-foreground" role="status">Loading the organization…</p>
    {:else if view.status === "forbidden"}
      <p class="text-workspace-chrome text-muted-foreground" role="alert">You do not have access to this organization. It may be gone, or you may no longer be a member.</p>
    {:else if view.status === "signed-out"}
      <p class="text-workspace-chrome text-muted-foreground" role="alert">Sign in to Solus again to see this organization.</p>
    {:else if view.status === "offline" || view.status === "error"}
      <div class="flex items-center gap-3 text-workspace-chrome" role="alert">
        <span class="text-destructive">{view.status === "offline" ? "Solus could not reach your account." : view.message}</span>
        <Button variant="outline" size="sm" onclick={() => origin && organizationId && void store.load(origin, organizationId)}>Retry</Button>
      </div>
    {:else if ready}
      {#if ready.saveError}
        <p class="text-workspace-chrome text-destructive" role="alert">{ready.saveError}</p>
      {/if}

      <SettingsSection label="{settingsDefinitions['organization.section-members'].label} ({ready.settings.members.length})">
        {#snippet action()}
          {#if isOwner}
            <Button variant="outline" size="sm" onclick={() => openConsole("invite")}>Invite people</Button>
            <Button variant="ghost" size="sm" onclick={() => openConsole("members")}>Manage</Button>
          {/if}
        {/snippet}
        {#each ready.settings.members as person (person.userId)}
          <SettingsRow label={person.name || person.email || "Unnamed"} description={person.name ? person.email : undefined}>
            {#snippet control()}
              <span class="text-chrome-dense text-muted-foreground">{person.role === "owner" ? "Owner" : "Member"}</span>
            {/snippet}
          </SettingsRow>
        {/each}
      </SettingsSection>

      <SettingsSection {...settingsDefinitions["organization.section-hosts"]}>
        <SettingsRow {...settingsDefinitions["organization.allow-cloud-hosts"]}>
          {#snippet control()}
            <Switch
              checked={ready.settings.hostRules.allowCloudHosts}
              disabled={!isOwner || ready.isSaving}
              onCheckedChange={(next) => void saveRules({ allowCloudHosts: next })}
              aria-label="Allow cloud hosts"
            />
          {/snippet}
        </SettingsRow>
        <SettingsRow {...settingsDefinitions["organization.allow-personal-hosts"]}>
          {#snippet control()}
            <Switch
              checked={ready.settings.hostRules.allowPersonalHosts}
              disabled={!isOwner || ready.isSaving}
              onCheckedChange={(next) => void saveRules({ allowPersonalHosts: next })}
              aria-label="Allow personal hosts"
            />
          {/snippet}
        </SettingsRow>
        <SettingsRow {...settingsDefinitions["organization.default-packages"]}>
          {#snippet body()}
            {#if isOwner}
              <Input
                class="font-mono text-xs"
                aria-label="Default packages"
                placeholder="postgresql-client ripgrep"
                dictation={false}
                disabled={ready.isSaving}
                value={packagesDraft ?? ready.settings.hostRules.defaultPackages.join(" ")}
                oninput={(event) => (packagesDraft = event.currentTarget.value)}
                onblur={() => void savePackages()}
                onkeydown={(event) => { if (event.key === "Enter") void savePackages(); }}
              />
            {:else}
              <p class="font-mono text-xs text-(--solus-text-secondary)">{ready.settings.hostRules.defaultPackages.join(" ") || "None"}</p>
            {/if}
          {/snippet}
        </SettingsRow>
        <SettingsRow {...settingsDefinitions["organization.default-setup-script"]}>
          {#snippet body()}
            {#if isOwner}
              <Textarea
                class="min-h-22 font-mono text-xs"
                aria-label="Default setup script"
                spellcheck={false}
                dictation={false}
                disabled={ready.isSaving}
                value={scriptDraft ?? ready.settings.hostRules.defaultSetupScript ?? ""}
                oninput={(event) => (scriptDraft = event.currentTarget.value)}
                onblur={() => void saveScript()}
              />
            {:else if ready.settings.hostRules.defaultSetupScript}
              <pre class="overflow-x-auto rounded-lg bg-(--wash-1) px-3 py-2.5 font-mono text-xs whitespace-pre-wrap text-(--solus-text-secondary)">{ready.settings.hostRules.defaultSetupScript}</pre>
            {:else}
              <p class="text-xs text-(--solus-text-secondary)">None</p>
            {/if}
          {/snippet}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label="Policy">
        <SettingsRow {...settingsDefinitions["organization.policy"]}>
          {#snippet control()}
            <Button variant="outline" size="sm" onclick={() => session.showSettings("policy", "click")}>Open Policy</Button>
          {/snippet}
        </SettingsRow>
        {#if isOwner}
          <SettingsRow label="Audit log and observability" description="Who changed what, and how the organization's agents run. In the Solus console.">
            {#snippet control()}
              <Button variant="ghost" size="sm" onclick={() => openConsole("audit")}>Audit log</Button>
              <Button variant="ghost" size="sm" onclick={() => openConsole("observability")}>Observability</Button>
            {/snippet}
          </SettingsRow>
        {/if}
      </SettingsSection>

      <SettingsSection label="Membership">
        <SettingsRow {...settingsDefinitions["organization.leave"]}>
          {#snippet control()}
            <Button variant="outline" size="sm" onclick={() => openConsole("leave")}>Leave…</Button>
          {/snippet}
        </SettingsRow>
        {#if isOwner}
          <SettingsRow {...settingsDefinitions["organization.delete"]}>
            {#snippet control()}
              <Button variant="destructive" size="sm" onclick={() => openConsole("delete")}>Delete…</Button>
            {/snippet}
          </SettingsRow>
        {/if}
      </SettingsSection>
    {/if}
  {/if}
{/if}

<SettingsCloudProjects />
