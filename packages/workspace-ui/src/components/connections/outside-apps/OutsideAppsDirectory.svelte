<script lang="ts">
  /** "Use Solus from your other apps" on Settings › Sharing & access
   *  (plans/035 §10): every app of the catalog in two columns, cloud apps on
   *  the left and apps on a computer on the right, with "Another MCP app"
   *  last. A row opens in place to connect its app or manage its sign-in. A
   *  host with no internet address shows the three ways to give it one first.
   *  The apps that signed in come from the host's paired devices, which only
   *  its owner reads; sign-ins that match no app are listed under the
   *  directory. "Approve a sign-in" is the header's small action. */
  import { untrack } from "svelte";
  import { AppWindow as AppIcon } from "@lucide/svelte";
  import { LOCAL_POLICY_ORGANIZATION_ID } from "@solus/contracts/policy";
  import { connectionsStore, getWorkspaceContext } from "../../../contexts";
  import { hosts } from "../../../contexts/hosts/hosts.svelte";
  import { policiesOn, workPolicy } from "../../../contexts/policy/work-policy.svelte";
  import { Button } from "../../ui/button";
  import { SearchField } from "../../ui/search-field";
  import { matchesSearch } from "../../../lib/search-match";
  import { approveSignInRequest } from "../lib/access-tab-requests.svelte";
  import { outsideAppChoices } from "../lib/outside-apps";
  import { revokeAllAppsQuestion } from "../lib/paired-devices";
  import { sharingAccessRoute } from "../lib/sharing-access";
  import {
    activeGrants,
    appRowState,
    directoryColumns,
    grantFacts,
    guideMatchesSearch,
    hasInternetAddress,
    matchGrants,
    OTHER_APP_LINE,
    outsideAppLine,
  } from "../lib/outside-apps-directory";
  import { toasts } from "../../../lib/toasts";
  import { hostLabel, isHostComputer } from "./outside-apps.svelte";
  import OutsideAppRow from "./OutsideAppRow.svelte";
  import OutsideAppsReach from "./OutsideAppsReach.svelte";
  import OutsideAppsApprove from "./OutsideAppsApprove.svelte";

  interface Props {
    serverId: string;
    /** The host's owner reads its sign-ins; anyone else sees every app as not connected. */
    readsGrants: boolean;
  }

  let { serverId, readsGrants }: Props = $props();

  /** The open row's id: a guide id, or `OTHER` for Another MCP app. */
  const OTHER = "other";
  const OTHER_NAME = "Another MCP app";

  const workspace = getWorkspaceContext();
  let search = $state("");
  let openRowId = $state<string | null>(null);
  let approval = $state<{ requestId: string | null } | null>(null);
  let isRevokingAll = $state(false);
  let directoryEl = $state<HTMLElement | null>(null);

  const hostName = $derived(hostLabel(serverId));
  const onHostComputer = $derived(isHostComputer(serverId));
  // The host checks an app against the policy of the person who approves it:
  // a member's organization, or the owner's personal work (plans/035 §0.3).
  const appPolicy = $derived(
    hosts.get(serverId).me.principal === "org-member"
      ? workPolicy(serverId)
      : policiesOn(serverId).forWork(LOCAL_POLICY_ORGANIZATION_ID),
  );
  const denials = $derived(new Map(outsideAppChoices(appPolicy).map((choice) => [choice.guide.id, choice.denial])));
  const otherDenial = $derived(appPolicy.appDenial("other")?.message ?? null);
  const grants = $derived(readsGrants ? activeGrants(connectionsStore.pairedDevices) : []);
  const matched = $derived(matchGrants(grants));
  const internet = $derived(hasInternetAddress(connectionsStore.appEndpointFor(serverId)));
  const columns = $derived.by(() => {
    const { cloud, computer } = directoryColumns();
    return {
      cloud: cloud.filter((guide) => guideMatchesSearch(guide, search)),
      computer: computer.filter((guide) => guideMatchesSearch(guide, search)),
    };
  });
  const showsOther = $derived(matchesSearch(`${OTHER_NAME} ${OTHER_APP_LINE}`, search));
  const hasNoMatch = $derived(columns.cloud.length === 0 && columns.computer.length === 0 && !showsOther);
  const unmatched = $derived(matched.unmatched.filter((grant) => matchesSearch(grant.deviceLabel, search)));

  $effect(() => {
    const targetServerId = serverId;
    untrack(() => void connectionsStore.loadAppEndpoint(targetServerId));
  });

  // The palette's "Approve an app sign-in" and a sign-in link open the approve view here.
  $effect(() => {
    if (approveSignInRequest.serverId !== serverId) return;
    untrack(() => {
      const asked = approveSignInRequest.take(serverId);
      if (asked) approval = asked;
    });
  });

  function toggle(rowId: string) {
    openRowId = openRowId === rowId ? null : rowId;
  }

  /** Escape closes the open row and leaves the keyboard on it. */
  function closeOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape" || openRowId === null || event.defaultPrevented) return;
    // The row closes, not the page around it.
    event.preventDefault();
    event.stopPropagation();
    const rowId = openRowId;
    openRowId = null;
    directoryEl?.querySelector<HTMLElement>(`[data-outside-app-row="${rowId}"]`)?.focus();
  }

  function showApprovalOn(otherServerId: string, requestId: string) {
    approveSignInRequest.ask(otherServerId, requestId);
    workspace.router.navigate(sharingAccessRoute(otherServerId), { replace: false });
  }

  async function revokeAll() {
    if (isRevokingAll || grants.length === 0) return;
    if (!window.confirm(revokeAllAppsQuestion(grants.length, hostName))) return;
    isRevokingAll = true;
    const isDone = await connectionsStore.revokeDevices(serverId, grants.map((grant) => grant.deviceId));
    isRevokingAll = false;
    if (!isDone) toasts.error("Some apps were not disconnected", { description: "Try Disconnect on each app that is still connected." });
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section bind:this={directoryEl} class="@container/directory flex flex-col gap-7" aria-labelledby="outside-apps-title" onkeydown={closeOnEscape}>
  <header class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
    <div class="flex min-w-0 flex-col gap-2">
      <h2 id="outside-apps-title" class="text-[1.375rem] leading-7 font-semibold tracking-[-0.02em] text-pretty text-(--solus-text-primary)">Use Solus from your other apps</h2>
      <p class="text-[0.9375rem] leading-5.5 text-pretty text-(--solus-text-secondary)">Each app signs in once and acts as you on {hostName}.</p>
    </div>
    <div class="flex min-w-0 flex-wrap items-center gap-2 @max-[44rem]/directory:w-full">
      <Button variant="ghost" size="sm" class="bg-muted" aria-expanded={approval !== null} onclick={() => (approval = approval ? null : { requestId: null })}>
        Approve a sign-in
      </Button>
      <SearchField bind:value={search} placeholder="Search apps" class="w-52 flex-none basis-auto rounded-[0.625rem] @max-[44rem]/directory:w-auto @max-[44rem]/directory:flex-1" />
    </div>
  </header>

  {#if approval}
    <div class="flex flex-col gap-4 rounded-xl bg-(--solus-tx-card-bg) p-5 shadow-[shadow:var(--solus-card-shadow-collapsed)]">
      {#key approval}
        <OutsideAppsApprove {serverId} {hostName} signInRequestId={approval.requestId} onOtherHost={showApprovalOn} />
      {/key}
      <div class="flex justify-end">
        <Button variant="ghost" size="sm" class="bg-muted" onclick={() => (approval = null)}>Done</Button>
      </div>
    </div>
  {/if}

  <!-- The one address apps reach this host by, above the apps that need it (docs/outside-apps.md). -->
  <OutsideAppsReach {serverId} {hostName} />

  {#if hasNoMatch}
    <p class="py-6 text-center text-workspace-chrome text-(--solus-text-tertiary)">No app matches “{search.trim()}”.</p>
  {:else}
    <div class="grid grid-cols-1 items-start gap-x-10 @min-[44rem]/directory:grid-cols-2">
      <div class="flex min-w-0 flex-col @max-[44rem]/directory:border-b @max-[44rem]/directory:border-border">
        {#each columns.cloud as guide (guide.id)}
          {@const appGrants = matched.byGuide.get(guide.id) ?? []}
          {@const denial = denials.get(guide.id) ?? null}
          <OutsideAppRow
            {serverId}
            {hostName}
            {guide}
            name={guide.name}
            line={outsideAppLine(guide)}
            state={appRowState({ needsPublicUrl: true, hasGrant: appGrants.length > 0, hasInternetAddress: internet, isDenied: denial !== null })}
            {denial}
            grants={appGrants}
            {onHostComputer}
            isOpen={openRowId === guide.id}
            onToggle={() => toggle(guide.id)}
          />
        {/each}
      </div>
      <div class="flex min-w-0 flex-col">
        {#each columns.computer as guide (guide.id)}
          {@const appGrants = matched.byGuide.get(guide.id) ?? []}
          {@const denial = denials.get(guide.id) ?? null}
          <OutsideAppRow
            {serverId}
            {hostName}
            {guide}
            name={guide.name}
            line={outsideAppLine(guide)}
            state={appRowState({ needsPublicUrl: false, hasGrant: appGrants.length > 0, hasInternetAddress: internet, isDenied: denial !== null })}
            {denial}
            grants={appGrants}
            {onHostComputer}
            isOpen={openRowId === guide.id}
            onToggle={() => toggle(guide.id)}
          />
        {/each}
        {#if showsOther}
          <OutsideAppRow
            {serverId}
            {hostName}
            guide={null}
            name={OTHER_NAME}
            line={OTHER_APP_LINE}
            state={otherDenial ? "not-allowed" : "connect"}
            denial={otherDenial}
            grants={[]}
            {onHostComputer}
            isOpen={openRowId === OTHER}
            onToggle={() => toggle(OTHER)}
          />
        {/if}
      </div>
    </div>
  {/if}

  {#if unmatched.length > 0}
    <div class="flex flex-col">
      <h3 class="border-b border-border pb-3 text-[0.9375rem] leading-4.5 font-semibold text-(--solus-text-primary)">Other connected apps</h3>
      {#each unmatched as grant (grant.deviceId)}
        {@const facts = grantFacts(grant)}
        <div class="flex items-center gap-3.5 border-b border-border py-3 last:border-b-0">
          <span aria-hidden="true" class="flex size-11 shrink-0 items-center justify-center rounded-[0.6875rem] bg-muted ring-1 ring-black/8 dark:ring-white/12">
            <AppIcon size={18} class="text-(--solus-text-secondary)" />
          </span>
          <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate text-[0.9375rem] leading-4.5 font-semibold text-(--solus-text-primary)">{grant.deviceLabel}</span>
            <span class="truncate text-[0.8125rem] leading-4 text-(--solus-text-tertiary)">{facts.access} · Connected {facts.connected} · Last used: {facts.lastUsed}</span>
          </span>
          <Button variant="ghost" size="sm" class="shrink-0 text-(--solus-status-error) hover:text-(--solus-status-error)" aria-label={`Disconnect ${grant.deviceLabel}`} onclick={() => void connectionsStore.revokeDevice(serverId, grant.deviceId)}>
            Disconnect
          </Button>
        </div>
      {/each}
    </div>
  {/if}

  {#if grants.length > 1}
    <div class="-mt-4 flex justify-end">
      <Button variant="ghost" size="sm" class="text-(--solus-status-error) hover:text-(--solus-status-error)" disabled={isRevokingAll} onclick={() => void revokeAll()}>
        {isRevokingAll ? "Disconnecting…" : "Disconnect all apps"}
      </Button>
    </div>
  {/if}
</section>
