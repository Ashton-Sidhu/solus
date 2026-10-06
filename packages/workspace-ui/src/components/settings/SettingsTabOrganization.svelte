<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export const searchWords = ["organization", "owner", "member", "insights", "sync"];
</script>

<script lang="ts">
  /** Organization: the settings an organization enforces on its work, read from
   *  the account. Today that is only Sync all Insights. Owners edit a draft and
   *  save it against the revision they read; members see the same value without
   *  an editor. Choosing an organization here changes no window's or session's
   *  organization. Hosts, packages, and the setup script stay in the Solus console. */
  import { untrack } from "svelte";
  import { accountStore, serversStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import { Switch } from "../ui/switch";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import { isDraftDirty } from "./lib/organization-draft";
  import { organizationSettingsStore as store } from "./organization-settings.store.svelte";

  let { searchQuery = "" }: { searchQuery?: string } = $props();

  const account = $derived(accountStore.state);
  const origin = $derived(account.kind === "signed-in" ? account.consoleUrl : null);
  const organizations = $derived(serversStore.organizations);
  const organizationId = $derived(
    organizations.find((organization) => organization.organizationId === store.selectedOrganizationId)?.organizationId
      ?? organizations.find((organization) => organization.isActive)?.organizationId
      ?? organizations[0]?.organizationId
      ?? null,
  );
  const view = $derived(origin && organizationId ? store.viewFor(origin, organizationId) : undefined);
  const ready = $derived(view?.status === "ready" ? view : null);
  const canEdit = $derived(!!ready?.settings.canManageSettings && !ready.saving && !ready.conflict);
  const dirty = $derived(ready ? isDraftDirty(ready.settings, ready.draft) : false);
  const consoleHost = $derived(origin?.replace(/^https?:\/\//, "") ?? "the Solus console");

  $effect(() => {
    const target = origin;
    const id = organizationId;
    if (target && id) untrack(() => void store.load(target, id));
  });

  function setSyncAllInsights(next: boolean) {
    if (origin && organizationId) store.edit(origin, organizationId, { syncAllInsights: next });
  }

  async function save() {
    if (!origin || !organizationId) return;
    await store.save(origin, organizationId);
    requestInputFocus();
  }

  function cancel() {
    if (origin && organizationId) store.cancel(origin, organizationId);
    requestInputFocus();
  }

  const matches = $derived(!searchQuery || searchWords.some((word) => word.includes(searchQuery.toLowerCase())));
</script>

{#if matches}
  {#if account.kind !== "signed-in"}
    <p class="text-workspace-chrome text-muted-foreground" role="status">Sign in to Solus to see your organizations' settings.</p>
  {:else if organizations.length === 0}
    <p class="text-workspace-chrome text-muted-foreground" role="status">You are not a member of an organization.</p>
  {:else}
    <SettingsSection label="Organization">
      <SettingsRow
        label="Settings for"
        description={ready
          ? ready.settings.canManageSettings
            ? "You are an owner: you can change these."
            : "Members can read these. Only owners change them."
          : "Choose an organization."}
      >
        {#snippet control()}
          <SettingsSelect
            options={organizations.map((organization) => ({ value: organization.organizationId, label: organization.name }))}
            value={organizationId ?? ""}
            onSelect={(id) => (store.selectedOrganizationId = id)}
            ariaLabel="Organization"
          />
        {/snippet}
      </SettingsRow>
    </SettingsSection>

    {#if !view || view.status === "loading"}
      <p class="text-workspace-chrome text-muted-foreground" role="status">Loading organization settings…</p>
    {:else if view.status === "forbidden"}
      <p class="text-workspace-chrome text-muted-foreground" role="alert">
        You do not have access to this organization's settings. It may be gone, or you may no longer be a member.
      </p>
    {:else if view.status === "signed-out"}
      <p class="text-workspace-chrome text-muted-foreground" role="alert">Sign in to Solus again to read organization settings.</p>
    {:else if view.status === "offline" || view.status === "error"}
      <div class="flex items-center gap-3 text-workspace-chrome" role="alert">
        <span class="text-destructive">{view.status === "offline" ? "Solus could not reach your account." : view.message}</span>
        <Button variant="outline" size="sm" onclick={() => origin && organizationId && void store.load(origin, organizationId)}>Retry</Button>
      </div>
    {:else if ready}
      <SettingsSection label="Insights" description="This setting applies to this organization's work only, from its next turn.">
        <SettingsRow
          label="Sync all Insights"
          description={ready.draft.syncAllInsights
            ? "On: every session of this organization sends its Insights to the organization. Members cannot turn it off."
            : "Off: Insights go only from managed machines, from explicit shares, and from hosts that opt in."}
        >
          {#snippet control()}
            <Switch
              checked={ready.draft.syncAllInsights}
              disabled={!canEdit}
              onCheckedChange={setSyncAllInsights}
              aria-label="Sync all Insights"
            />
          {/snippet}
        </SettingsRow>
      </SettingsSection>

      <p class="text-xs text-muted-foreground">
        Hosts, default packages, and the setup script of this organization are in the Solus console at {consoleHost}.
      </p>

      {#if ready.conflict}
        <div class="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs" role="alert" data-testid="organization-settings-conflict">
          <p class="text-foreground">
            Another owner saved these settings while you edited. Nothing of yours was saved.
          </p>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onclick={() => origin && organizationId && store.resolveConflict(origin, organizationId, "use-theirs")}>Use their settings</Button>
            <Button size="sm" variant="outline" onclick={() => origin && organizationId && store.resolveConflict(origin, organizationId, "keep-mine")}>Keep my edits</Button>
          </div>
        </div>
      {/if}

      {#if ready.settings.canManageSettings}
        <div class="flex flex-col gap-2" aria-live="polite">
          {#if ready.settings.settings.syncAllInsights && !ready.draft.syncAllInsights}
            <p class="text-xs text-muted-foreground" role="status">
              Saving stops Sync all Insights. Insights then go only from managed machines, explicit shares, and hosts that opt in.
            </p>
          {/if}
          {#if ready.error}
            <p class="text-xs text-destructive" role="alert">{ready.error}</p>
          {/if}
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={!dirty || ready.saving} onclick={cancel}>Cancel</Button>
            <Button size="sm" disabled={!dirty || ready.saving || !!ready.conflict} onclick={() => void save()}>
              {ready.saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      {/if}
    {/if}
  {/if}
{/if}
