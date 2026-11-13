<script lang="ts">
  import { policySearchWords as searchWords } from "../lib/settings-search-data";
  /** Settings → Policy (plans/030 §7): the MDM policy of this host, read-only;
   *  the organization policy and the host policies, which owners edit and
   *  assign; and a document anyone can build and export for MDM. Each save is
   *  sent against the revision that was read. */
  import { untrack } from "svelte";
  import { Copy as CopyIcon, Plus as PlusIcon } from "@lucide/svelte";
  import type { PolicyKind } from "@solus/contracts/policy";
  import { accountStore, hosts, serversStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import SettingsSelect from "../SettingsSelect.svelte";
  import PolicyDocumentEditor from "./PolicyDocumentEditor.svelte";
  import PolicyHostAssignments from "./PolicyHostAssignments.svelte";
  import { copyAsNew, hostOwnerName, mdmDescription, newPolicyDocument, policyText } from "./lib/policy-editor";
  import { policyStore as store, type PolicyEditorTarget } from "./policy.store.svelte";

  let { searchQuery = "", serverId = null }: { searchQuery?: string; serverId?: string | null } = $props();

  const KINDS: { value: PolicyKind; label: string }[] = [
    { value: "mdm", label: "MDM policy" },
    { value: "host", label: "Host policy" },
    { value: "organization", label: "Organization policy" },
  ];

  const account = $derived(accountStore.state);
  const origin = $derived(account.kind === "signed-in" ? account.consoleUrl : null);
  const organizations = $derived(serversStore.organizations);
  const organizationId = $derived(
    organizations.find((organization) => organization.organizationId === store.selectedOrganizationId)?.organizationId
      ?? organizations.find((organization) => organization.isActive)?.organizationId
      ?? organizations[0]?.organizationId
      ?? null,
  );
  const organizationName = $derived(organizations.find((organization) => organization.organizationId === organizationId)?.name ?? "");
  const view = $derived(origin && organizationId ? store.viewFor(origin, organizationId) : undefined);
  const ready = $derived(view?.status === "ready" ? view : null);
  const canManage = $derived(!!ready?.organization.canManage);
  const policySet = $derived(serverId ? hosts.get(serverId).policies?.set : undefined);
  const mdm = $derived(policySet?.mdm ?? null);
  const ownerName = $derived(hostOwnerName(policySet, organizations));

  const ORGANIZATION: PolicyEditorTarget = { kind: "organization" };
  let selectedPolicyId = $state<string | null>(null);
  const hostPolicies = $derived(ready?.hostPolicies?.policies ?? []);
  const editedPolicy = $derived(hostPolicies.find((policy) => policy.policyId === selectedPolicyId) ?? hostPolicies[0] ?? null);
  const hostTarget = $derived<PolicyEditorTarget | null>(editedPolicy ? { kind: "host", policyId: editedPolicy.policyId } : null);
  let newPolicyName = $state("");
  let createError = $state<string | null>(null);
  let creating = $state(false);
  let confirmingDelete = $state(false);
  let deleteError = $state<string | null>(null);
  let builderSection = $state<HTMLElement | null>(null);

  $effect(() => {
    const target = origin;
    const id = organizationId;
    if (target && id) untrack(() => void store.load(target, id));
  });

  function draft(target: PolicyEditorTarget | null) {
    return origin && organizationId && target ? store.draftFor(origin, organizationId, target) : undefined;
  }

  async function save(target: PolicyEditorTarget) {
    if (!origin || !organizationId) return;
    await store.save(origin, organizationId, target);
    requestInputFocus();
  }

  function cancel(target: PolicyEditorTarget) {
    if (origin && organizationId) store.cancel(origin, organizationId, target);
    requestInputFocus();
  }

  async function createHostPolicy() {
    if (!origin || !organizationId || !newPolicyName.trim()) return;
    creating = true;
    const result = await store.createHostPolicy(origin, organizationId, newPolicyName, policyText(newPolicyDocument("host", organizationName, newPolicyName.trim())));
    creating = false;
    if ("error" in result) {
      createError = result.error;
      return;
    }
    createError = null;
    newPolicyName = "";
    selectedPolicyId = result.policyId;
  }

  async function deleteHostPolicy(policyId: string) {
    if (!origin || !organizationId) return;
    deleteError = await store.deleteHostPolicy(origin, organizationId, policyId);
    confirmingDelete = false;
    if (!deleteError) selectedPolicyId = null;
    requestInputFocus();
  }

  function copyMdmAsNew() {
    if (!mdm) return;
    store.setBuilder({ kind: "mdm", text: policyText(copyAsNew(mdm.document)) });
    builderSection?.scrollIntoView({ block: "start" });
    builderSection?.querySelector("textarea")?.focus();
  }

  function newBuilderDocument(kind: PolicyKind) {
    store.setBuilder({ kind, text: policyText(newPolicyDocument(kind, organizationName || "My organization")) });
  }

  const matches = $derived(!searchQuery || searchWords.some((word) => word.includes(searchQuery.toLowerCase())));
</script>

{#snippet draftActions(target: PolicyEditorTarget)}
  {@const current = draft(target)}
  {#if current && canManage}
    {@const dirty = current.text !== current.saved.text}
    <Button variant="ghost" size="sm" disabled={!dirty || current.saving} onclick={() => cancel(target)}>Cancel</Button>
    <Button size="sm" disabled={!dirty || current.saving || !!current.conflict} onclick={() => void save(target)}>
      {current.saving ? "Saving…" : "Save"}
    </Button>
  {/if}
{/snippet}

{#snippet draftNotices(target: PolicyEditorTarget)}
  {@const current = draft(target)}
  {#if current?.conflict}
    <div class="flex flex-col gap-2 rounded-lg border border-border p-3 text-xs" role="alert" data-testid="policy-conflict">
      <p class="text-foreground">Another owner saved this policy while you edited it. Nothing of yours was saved.</p>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onclick={() => origin && organizationId && store.resolveConflict(origin, organizationId, target, "use-theirs")}>Use their policy</Button>
        <Button size="sm" variant="outline" onclick={() => origin && organizationId && store.resolveConflict(origin, organizationId, target, "keep-mine")}>Keep my edits</Button>
      </div>
    </div>
  {/if}
  {#if current?.error}
    <p class="whitespace-pre-line text-xs text-destructive" role="alert">{current.error}</p>
  {/if}
{/snippet}

{#if matches}
  {#if serverId}
    <SettingsSection
      label="This host"
      description={mdmDescription(policySet)}
    >
      {#if ownerName}
        <SettingsRow label="Host settings" description={`${ownerName} manages this host's settings.`} />
      {/if}
      {#if mdm}
        <SettingsRow label="MDM policy" description="Read-only. Launch pins and the update feed are not shown.">
          {#snippet body()}
            <PolicyDocumentEditor label="MDM policy" kind="mdm" text={policyText(mdm.document)} readOnly>
              {#snippet actions()}
                <Button variant="outline" size="sm" onclick={copyMdmAsNew}>
                  <CopyIcon size={16} />
                  Copy as new
                </Button>
              {/snippet}
            </PolicyDocumentEditor>
          {/snippet}
        </SettingsRow>
      {/if}
    </SettingsSection>
  {/if}

  {#if account.kind === "signed-in" && organizations.length > 0}
    <SettingsSection label="Organization">
      <SettingsRow
        label="Policies of"
        description={ready ? (canManage ? "You are an owner: you can change these." : "Members can read these. Only owners change them.") : "Choose an organization."}
      >
        {#snippet control()}
          <SettingsSelect
            options={organizations.map((organization) => ({ value: organization.organizationId, label: organization.name }))}
            value={organizationId ?? ""}
            onSelect={(id) => { store.selectedOrganizationId = id; selectedPolicyId = null; }}
            ariaLabel="Organization"
          />
        {/snippet}
      </SettingsRow>
    </SettingsSection>

    {#if !view || view.status === "loading"}
      <p class="text-workspace-chrome text-muted-foreground" role="status">Loading policies…</p>
    {:else if view.status === "forbidden"}
      <p class="text-workspace-chrome text-muted-foreground" role="alert">You do not have access to this organization's policies. It may be gone, or you may no longer be a member.</p>
    {:else if view.status === "signed-out"}
      <p class="text-workspace-chrome text-muted-foreground" role="alert">Sign in to Solus again to read policies.</p>
    {:else if view.status === "offline" || view.status === "error"}
      <div class="flex items-center gap-3 text-workspace-chrome" role="alert">
        <span class="text-destructive">{view.status === "offline" ? "Solus could not reach your account." : view.message}</span>
        <Button variant="outline" size="sm" onclick={() => origin && organizationId && void store.load(origin, organizationId)}>Retry</Button>
      </div>
    {:else if ready}
      {@const organizationDraft = draft(ORGANIZATION)}
      <SettingsSection label="Organization policy" description="Applies to this organization's work on every host, after the MDM policy and the host policy. It cannot hold host settings.">
        {#if organizationDraft}
          <SettingsRow label={`Revision ${organizationDraft.saved.revision}`}>
            {#snippet body()}
              <div class="flex flex-col gap-2">
                <PolicyDocumentEditor
                  label="Organization policy"
                  kind="organization"
                  text={organizationDraft.text}
                  base={organizationDraft.saved.document}
                  readOnly={!canManage || organizationDraft.saving || !!organizationDraft.conflict}
                  onChange={(text) => origin && organizationId && store.edit(origin, organizationId, ORGANIZATION, text)}
                >
                  {#snippet actions()}{@render draftActions(ORGANIZATION)}{/snippet}
                </PolicyDocumentEditor>
                {@render draftNotices(ORGANIZATION)}
              </div>
            {/snippet}
          </SettingsRow>
        {/if}
      </SettingsSection>

      <SettingsSection label="Host policies" description="A host policy applies to this organization's work on the hosts it is assigned to. Its host settings apply to the whole machine.">
        {#if ready.hostPoliciesError}
          <p class="px-4 py-3 text-xs text-destructive" role="alert">{ready.hostPoliciesError}</p>
        {/if}
        {#if hostPolicies.length > 0 && editedPolicy && hostTarget}
          {@const hostDraft = draft(hostTarget)}
          <SettingsRow label="Edit" description={`Assigned to ${editedPolicy.hostIds.length === 1 ? "1 host" : `${editedPolicy.hostIds.length} hosts`}.`}>
            {#snippet control()}
              <SettingsSelect
                options={hostPolicies.map((policy) => ({ value: policy.policyId, label: policy.name }))}
                value={editedPolicy.policyId}
                onSelect={(id) => { selectedPolicyId = id; confirmingDelete = false; }}
                ariaLabel="Host policy"
              />
            {/snippet}
            {#snippet body()}
              {#if hostDraft}
                <div class="flex flex-col gap-2">
                  <PolicyDocumentEditor
                    label={`Host policy ${editedPolicy.name}`}
                    kind="host"
                    text={hostDraft.text}
                    base={hostDraft.saved.document}
                    readOnly={!canManage || hostDraft.saving || !!hostDraft.conflict}
                    onChange={(text) => origin && organizationId && store.edit(origin, organizationId, hostTarget, text)}
                  >
                    {#snippet actions()}
                      {#if canManage}
                        {#if confirmingDelete}
                          <Button variant="destructive" size="sm" onclick={() => void deleteHostPolicy(editedPolicy.policyId)}>Delete {editedPolicy.name}</Button>
                          <Button variant="ghost" size="sm" onclick={() => (confirmingDelete = false)}>Keep</Button>
                        {:else}
                          <Button variant="ghost" size="sm" onclick={() => (confirmingDelete = true)}>Delete…</Button>
                        {/if}
                      {/if}
                      {@render draftActions(hostTarget)}
                    {/snippet}
                  </PolicyDocumentEditor>
                  {@render draftNotices(hostTarget)}
                  {#if deleteError}
                    <p class="text-xs text-destructive" role="alert">{deleteError}</p>
                  {/if}
                </div>
              {/if}
            {/snippet}
          </SettingsRow>
        {:else if !ready.hostPoliciesError}
          <p class="px-4 py-3 text-workspace-chrome text-muted-foreground">This organization has no host policies.</p>
        {/if}
        {#if canManage}
          <SettingsRow label="New host policy" description={createError ?? "For example “Engineering laptops” or “CI runners”."}>
            {#snippet control()}
              <form class="flex gap-2" onsubmit={(event) => { event.preventDefault(); void createHostPolicy(); }}>
                <Input bind:value={newPolicyName} placeholder="Name" aria-label="New host policy name" class="h-8 w-44" maxlength={120} />
                <Button type="submit" size="sm" variant="outline" disabled={creating || !newPolicyName.trim()}>
                  <PlusIcon size={16} />
                  Create
                </Button>
              </form>
            {/snippet}
          </SettingsRow>
        {/if}
      </SettingsSection>

      {#if ready.hostPolicies}
        <SettingsSection label="Hosts" description="Each organization can assign one of its host policies to a host shared with it.">
          <PolicyHostAssignments
            organizationId={ready.organization.organizationId}
            hosts={ready.hostPolicies.hosts}
            policies={hostPolicies}
            {canManage}
            assigning={ready.assigning}
            onAssign={(hostId, policyId) => origin && organizationId && void store.assign(origin, organizationId, hostId, policyId)}
          />
          {#if ready.assignmentError}
            <p class="px-4 py-3 text-xs text-destructive" role="alert">{ready.assignmentError}</p>
          {/if}
        </SettingsSection>
      {/if}
    {/if}
  {/if}

  <section bind:this={builderSection} class="flex flex-col gap-3">
    <SettingsSection label="Build a policy" description="Write a policy and export it, for example as the MDM policy of your machines. Nothing here is saved to Solus Cloud.">
      <SettingsRow label="Kind" description="An organization policy cannot hold host settings.">
        {#snippet control()}
          <SettingsSelect options={KINDS} value={store.builder.kind} onSelect={(kind) => store.setBuilder({ kind })} ariaLabel="Policy kind" />
        {/snippet}
        {#snippet body()}
          <PolicyDocumentEditor label="Policy to build" kind={store.builder.kind} text={store.builder.text} onChange={(text) => store.setBuilder({ text })}>
            {#snippet actions()}
              <Button variant="ghost" size="sm" onclick={() => newBuilderDocument(store.builder.kind)}>Start again</Button>
            {/snippet}
          </PolicyDocumentEditor>
        {/snippet}
      </SettingsRow>
    </SettingsSection>
  </section>
{/if}
