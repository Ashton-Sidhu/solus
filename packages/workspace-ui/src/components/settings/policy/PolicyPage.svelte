<script lang="ts">
  import { policySearchWords as searchWords } from "../lib/settings-search-data";
  /** Settings → Policy (plans/030 §7). First, what applies on this host: each
   *  policy, in the order it wins, with its rules in words. Then, for a signed-in
   *  member, the organization's policies, which owners edit and assign to hosts.
   *  Last, a policy file to download for an MDM tool. Each save is sent against
   *  the revision that was read. */
  import { untrack } from "svelte";
  import { Copy as CopyIcon, Plus as PlusIcon } from "@lucide/svelte";
  import { accountStore, hosts, serversStore } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import SettingsSection from "../SettingsSection.svelte";
  import SettingsRow from "../SettingsRow.svelte";
  import SettingsSelect from "../SettingsSelect.svelte";
  import PolicyDocumentEditor from "./PolicyDocumentEditor.svelte";
  import PolicyHostAssignments from "./PolicyHostAssignments.svelte";
  import PolicyRuleList from "./PolicyRuleList.svelte";
  import { copyAsNew, newPolicyDocument, policyText } from "./lib/policy-editor";
  import { appliedPolicies, storedPolicyRules } from "./lib/policy-rules";
  import { policyStore as store, type PolicyEditorTarget } from "./policy.store.svelte";

  let { searchQuery = "", serverId = null }: { searchQuery?: string; serverId?: string | null } = $props();

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
  const applied = $derived(appliedPolicies(policySet, organizations));

  const ORGANIZATION: PolicyEditorTarget = { kind: "organization" };
  const hostPolicies = $derived(ready?.hostPolicies?.policies ?? []);
  /** The one policy whose editor is open: "organization", a host policy id, or null. */
  let openPolicyKey = $state<string | null>(null);
  let isCreatingHostPolicy = $state(false);
  let newPolicyName = $state("");
  let createError = $state<string | null>(null);
  let creating = $state(false);
  let confirmingDeleteId = $state<string | null>(null);
  let deleteError = $state<string | null>(null);
  let isFileOpen = $state(false);
  let fileSection = $state<HTMLElement | null>(null);

  $effect(() => {
    const target = origin;
    const id = organizationId;
    if (target && id) untrack(() => void store.load(target, id));
  });

  function draft(target: PolicyEditorTarget) {
    return origin && organizationId ? store.draftFor(origin, organizationId, target) : undefined;
  }

  function hostTarget(policyId: string): PolicyEditorTarget {
    return { kind: "host", policyId };
  }

  function toggleEditor(key: string) {
    openPolicyKey = openPolicyKey === key ? null : key;
    confirmingDeleteId = null;
    deleteError = null;
  }

  async function save(target: PolicyEditorTarget) {
    if (!origin || !organizationId) return;
    await store.save(origin, organizationId, target);
    if (!draft(target)?.error && !draft(target)?.conflict) openPolicyKey = null;
    requestInputFocus();
  }

  function cancel(target: PolicyEditorTarget) {
    if (origin && organizationId) store.cancel(origin, organizationId, target);
    openPolicyKey = null;
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
    isCreatingHostPolicy = false;
    openPolicyKey = result.policyId;
  }

  async function deleteHostPolicy(policyId: string) {
    if (!origin || !organizationId) return;
    deleteError = await store.deleteHostPolicy(origin, organizationId, policyId);
    confirmingDeleteId = null;
    if (!deleteError) openPolicyKey = null;
    requestInputFocus();
  }

  function copyMdmAsNew() {
    if (!mdm) return;
    store.builderText = policyText(copyAsNew(mdm.document));
    isFileOpen = true;
    fileSection?.scrollIntoView({ block: "start" });
  }

  const matches = $derived(!searchQuery || searchWords.some((word) => word.includes(searchQuery.toLowerCase())));
</script>

{#snippet editorButton(key: string)}
  <Button variant="outline" size="sm" aria-expanded={openPolicyKey === key} onclick={() => toggleEditor(key)}>
    {openPolicyKey === key ? "Close" : canManage ? "Edit" : "View JSON"}
  </Button>
{/snippet}

{#snippet draftActions(target: PolicyEditorTarget)}
  {@const current = draft(target)}
  {#if current && canManage}
    {@const dirty = current.text !== current.saved.text}
    <Button variant="ghost" size="sm" disabled={current.saving} onclick={() => cancel(target)}>Cancel</Button>
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
      label="On this host"
      description={applied.length > 1 ? "When two policies set the same rule, the one higher in this list wins." : undefined}
    >
      {#if applied.length === 0}
        <SettingsRow
          label="No policy applies"
          description="You choose every setting on this host. An MDM policy from your IT team, or a policy of your organization, can lock settings here."
        />
      {/if}
      {#each applied as policy (policy.key)}
        <SettingsRow label={policy.title} description={policy.detail}>
          {#snippet control()}
            {#if policy.isMdm}
              <Button variant="outline" size="sm" onclick={copyMdmAsNew}>
                <CopyIcon size={16} />
                Copy as new
              </Button>
            {/if}
          {/snippet}
          {#snippet body()}<PolicyRuleList rules={policy.rules} />{/snippet}
        </SettingsRow>
      {/each}
    </SettingsSection>
  {/if}

  {#if account.kind === "signed-in" && organizations.length > 0}
    <SettingsSection
      label={organizations.length > 1 ? "Organization policies" : `${organizationName} policies`}
      description={ready
        ? canManage
          ? "You are an owner, so you can change these policies and choose the hosts they apply to."
          : "You can read these policies. Only owners can change them."
        : undefined}
    >
      {#snippet action()}
        {#if organizations.length > 1}
          <SettingsSelect
            options={organizations.map((organization) => ({ value: organization.organizationId, label: organization.name }))}
            value={organizationId ?? ""}
            onSelect={(id) => { store.selectedOrganizationId = id; openPolicyKey = null; }}
            ariaLabel="Organization"
          />
        {/if}
      {/snippet}

      {#if !view || view.status === "loading"}
        <p class="px-4 py-3 text-workspace-chrome text-muted-foreground" role="status">Loading policies…</p>
      {:else if view.status === "forbidden"}
        <p class="px-4 py-3 text-workspace-chrome text-muted-foreground" role="alert">You do not have access to this organization's policies. It may be gone, or you may no longer be a member.</p>
      {:else if view.status === "signed-out"}
        <p class="px-4 py-3 text-workspace-chrome text-muted-foreground" role="alert">Sign in to Solus again to read policies.</p>
      {:else if view.status === "offline" || view.status === "error"}
        <div class="flex items-center gap-3 px-4 py-3 text-workspace-chrome" role="alert">
          <span class="text-destructive">{view.status === "offline" ? "Solus could not reach your account." : view.message}</span>
          <Button variant="outline" size="sm" onclick={() => origin && organizationId && void store.load(origin, organizationId)}>Retry</Button>
        </div>
      {:else if ready}
        {@const organizationDraft = draft(ORGANIZATION)}
        <SettingsRow label="Organization policy" description={`Applies to ${organizationName}'s work on every host. It cannot hold host settings.`}>
          {#snippet control()}{#if organizationDraft}{@render editorButton("organization")}{/if}{/snippet}
          {#snippet body()}
            <div class="flex flex-col gap-3">
              {#if openPolicyKey !== "organization"}<PolicyRuleList rules={storedPolicyRules(organizationDraft?.saved.document ?? null)} />{/if}
              {#if organizationDraft && openPolicyKey === "organization"}
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
              {/if}
            </div>
          {/snippet}
        </SettingsRow>

        {#if ready.hostPoliciesError}
          <p class="px-4 py-3 text-xs text-destructive" role="alert">{ready.hostPoliciesError}</p>
        {/if}
        {#each hostPolicies as policy (policy.policyId)}
          {@const target = hostTarget(policy.policyId)}
          {@const hostDraft = draft(target)}
          <SettingsRow
            label={policy.name}
            description={`Host policy, on ${policy.hostIds.length === 1 ? "1 host" : `${policy.hostIds.length} hosts`}. Its host settings apply to the whole machine.`}
          >
            {#snippet control()}{#if hostDraft}{@render editorButton(policy.policyId)}{/if}{/snippet}
            {#snippet body()}
              <div class="flex flex-col gap-3">
                {#if openPolicyKey !== policy.policyId}<PolicyRuleList rules={storedPolicyRules(hostDraft?.saved.document ?? null)} />{/if}
                {#if hostDraft && openPolicyKey === policy.policyId}
                  <PolicyDocumentEditor
                    label={`Host policy ${policy.name}`}
                    kind="host"
                    text={hostDraft.text}
                    base={hostDraft.saved.document}
                    readOnly={!canManage || hostDraft.saving || !!hostDraft.conflict}
                    onChange={(text) => origin && organizationId && store.edit(origin, organizationId, target, text)}
                  >
                    {#snippet actions()}
                      {#if canManage}
                        {#if confirmingDeleteId === policy.policyId}
                          <Button variant="destructive" size="sm" onclick={() => void deleteHostPolicy(policy.policyId)}>Delete {policy.name}</Button>
                          <Button variant="ghost" size="sm" onclick={() => (confirmingDeleteId = null)}>Keep</Button>
                        {:else}
                          <Button variant="ghost" size="sm" onclick={() => (confirmingDeleteId = policy.policyId)}>Delete…</Button>
                        {/if}
                      {/if}
                      {@render draftActions(target)}
                    {/snippet}
                  </PolicyDocumentEditor>
                  {@render draftNotices(target)}
                  {#if deleteError}
                    <p class="text-xs text-destructive" role="alert">{deleteError}</p>
                  {/if}
                {/if}
              </div>
            {/snippet}
          </SettingsRow>
        {/each}

        {#if canManage}
          <SettingsRow
            label="New host policy"
            description={createError ?? "A host policy applies to the hosts you assign it to, for example “Engineering laptops” or “CI runners”."}
          >
            {#snippet control()}
              {#if isCreatingHostPolicy}
                <form class="flex gap-2" onsubmit={(event) => { event.preventDefault(); void createHostPolicy(); }}>
                  <!-- svelte-ignore a11y_autofocus -->
                  <Input bind:value={newPolicyName} placeholder="Name" aria-label="New host policy name" class="h-8 w-44" maxlength={120} autofocus />
                  <Button type="button" size="sm" variant="ghost" onclick={() => { isCreatingHostPolicy = false; newPolicyName = ""; createError = null; }}>Cancel</Button>
                  <Button type="submit" size="sm" disabled={creating || !newPolicyName.trim()}>{creating ? "Creating…" : "Create"}</Button>
                </form>
              {:else}
                <Button variant="outline" size="sm" onclick={() => (isCreatingHostPolicy = true)}>
                  <PlusIcon size={16} />
                  New host policy
                </Button>
              {/if}
            {/snippet}
          </SettingsRow>
        {/if}
      {/if}
    </SettingsSection>

    {#if ready?.hostPolicies && hostPolicies.length > 0}
      <SettingsSection label="Host assignments" description="The host policy that each host follows for this organization's work. A host follows one host policy of each organization.">
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

  <section bind:this={fileSection} class="flex flex-col gap-3">
    <SettingsSection label="MDM policy file">
      <SettingsRow
        label="Create a policy file"
        description="Write a policy and download it for your MDM tool, to lock settings on the machines it manages. Nothing here is saved to Solus Cloud."
      >
        {#snippet control()}
          <Button variant="outline" size="sm" aria-expanded={isFileOpen} onclick={() => (isFileOpen = !isFileOpen)}>{isFileOpen ? "Close" : "Create"}</Button>
        {/snippet}
        {#snippet body()}
          {#if isFileOpen}
            <PolicyDocumentEditor label="MDM policy file" kind="mdm" text={store.builderText} onChange={(text) => (store.builderText = text)}>
              {#snippet actions()}
                <Button variant="outline" size="sm" onclick={() => (store.builderText = policyText(newPolicyDocument("mdm", organizationName)))}>Start again</Button>
              {/snippet}
            </PolicyDocumentEditor>
          {/if}
        {/snippet}
      </SettingsRow>
    </SettingsSection>
  </section>
{/if}
