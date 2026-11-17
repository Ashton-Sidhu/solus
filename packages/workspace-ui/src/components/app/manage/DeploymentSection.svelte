<script lang="ts">
  import { untrack } from "svelte";
  import { ExternalLink as OpenIcon } from "@lucide/svelte";
  import {
    DEFAULT_DEPLOYMENT_CHOICES,
    DEPLOYMENT_ACCESS_OPTIONS,
    DEPLOYMENT_ROLE_OPTIONS,
    UNKNOWN_PUBLISH_PLACES,
    UNPUBLISH_QUESTION,
    deploymentAccessText,
    deploymentAddressNote,
    deploymentAddressText,
    deploymentCallsText,
    deploymentChangeQuestion,
    deploymentPlaceOf,
    deploymentPlaceOptions,
    deploymentPlaceProblem,
    deploymentPlaceValue,
    deploymentRoleText,
    deploymentStateText,
    firstPublishRequest,
    hasOneVisitorRole,
    offersTailscaleAddress,
    publishAgainRequest,
    publishRefusalText,
    sameSubjects,
    versionToPublish,
    type DeploymentChange,
    type DeploymentChoices,
    type DeploymentQuestion,
  } from "@solus/client-core/app-deployment";
  import { localApi } from "@solus/client-core/local-api";
  import type { AppAccessSubject, AppPublishRequest } from "@solus/contracts/app-deployments";
  import type { AppSummary } from "@solus/contracts/apps";
  import { sharesStore } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../ui/button";
  import CopyButton from "../../ui/CopyButton.svelte";
  import { Switch } from "../../ui/switch";
  import SettingsRow from "../../settings/SettingsRow.svelte";
  import SettingsSection from "../../settings/SettingsSection.svelte";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import { appTime } from "../lib/app-view";
  import DeploymentPeople from "./DeploymentPeople.svelte";
  import ManageHeading from "./ManageHeading.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import StateIcon from "./StateIcon.svelte";
  import { deploymentMark, subjectDirectoryOf } from "./lib/deployment";

  /**
   * The deployment of the app (docs/plans/app-deploy.md §9): the published
   * copy of its active version, in a container of its own. An app that is not
   * published shows the choices of a first publish. A published one shows how
   * the copy is, its address and its link, who opens it, where its webhooks
   * arrive, its log, and the way back: Unpublish. Each change is a publish, and a change that puts a
   * visitor out or sends a new version asks first.
   */
  let { serverId, app }: { serverId: string; app: AppSummary } = $props();

  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    return untrack(() => appsStore.deployment.watch(hostId, appId));
  });
  const deployment = $derived(appsStore.deployment.get(serverId, app.id));

  // What the host of the app has for a publish: its places, a Tailscale key, and a sign-in to Solus.
  // A host that cannot say is taken to have each of them, and says what it lacks at the publish.
  $effect(() => {
    const hostId = serverId;
    untrack(() => void appsStore.loadPublishPlaces(hostId));
  });
  const places = $derived(appsStore.publishPlacesFor(serverId) ?? UNKNOWN_PUBLISH_PLACES);
  const placeOptions = $derived(deploymentPlaceOptions(places.places));

  // The people and teams that the owner can name.
  $effect(() => {
    untrack(() => void sharesStore.loadDirectory().catch(() => {}));
  });
  const directory = $derived(subjectDirectoryOf(sharesStore.directory));
  const ownerKey = $derived(sharesStore.identities.get(serverId)?.userId ?? null);
  /** The list of a published app while the owner changes it; null when it is as the copy has it. */
  let subjectsDraft = $state<AppAccessSubject[] | null>(null);

  /** What the person chose for a first publish. */
  let choices = $state<DeploymentChoices>({ ...DEFAULT_DEPLOYMENT_CHOICES });
  let isBusy = $state(false);
  /** Why the last publish did not work. It stays in the section: the words say what to do. */
  let problem = $state<string | null>(null);

  let isLogOpen = $state(false);
  $effect(() => {
    const hostId = serverId;
    const appId = app.id;
    if (!isLogOpen || !deployment) return;
    return untrack(() => appsStore.deploymentLog.watch(hostId, appId));
  });
  const log = $derived(appsStore.deploymentLog.get(serverId, app.id));
  const logError = $derived(appsStore.deploymentLog.errorFor(serverId, app.id));

  const behindVersion = $derived(deployment ? versionToPublish(deployment, app.activeVersion) : null);

  function agrees(question: DeploymentQuestion | null): boolean {
    return question === null || confirm(`${question.title} ${question.detail}`);
  }

  async function publish(request: AppPublishRequest) {
    if (isBusy) return;
    isBusy = true;
    problem = null;
    try {
      problem = publishRefusalText(await appsStore.publish(serverId, request));
      subjectsDraft = null;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    } finally {
      isBusy = false;
    }
  }

  function change(next: DeploymentChange) {
    if (!deployment || !agrees(deploymentChangeQuestion(next, deployment, app.activeVersion))) return;
    void publish(publishAgainRequest(app.id, deployment, next));
  }

  async function unpublish() {
    if (isBusy || !agrees(UNPUBLISH_QUESTION)) return;
    isBusy = true;
    problem = null;
    try {
      await appsStore.unpublish(serverId, app.id);
      isLogOpen = false;
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    } finally {
      isBusy = false;
    }
  }
</script>

<ManageHeading
  title="Deployment"
  description="A copy of the active version in a container of its own, with an address that a browser opens. Publish it to give the app to people who do not have Solus."
/>

<ManageSectionState
  count={deployment === undefined ? undefined : 1}
  error={appsStore.deployment.errorFor(serverId, app.id)}
  empty=""
  onRetry={() => void appsStore.deployment.load(serverId, app.id)}
>
  <div class="flex min-w-0 flex-col gap-8" data-testid="app-deployment" aria-busy={isBusy}>
    {#if problem}
      <p class="m-0 rounded-[10px] bg-destructive/8 px-4 py-3 text-[13px] leading-5 text-pretty text-destructive select-text" role="alert" data-testid="app-deployment-problem">{problem}</p>
    {/if}

    {#if deployment}
      {@const view = deployment}
      {@const addressNote = deploymentAddressNote(view)}
      <SettingsSection>
        <SettingsRow
          label={deploymentStateText(view)}
          description={[`Published ${appTime(view.publishedAt)}`, deploymentCallsText(view)].filter(Boolean).join(" · ")}
          testId="app-deployment-state"
        >
          {#snippet icon()}
            <StateIcon state={deploymentMark(view)} />
          {/snippet}
          {#snippet control()}
            <Button size="sm" variant={behindVersion === null ? "outline" : "default"} disabled={isBusy || app.activeVersion === null} onclick={() => change({ kind: "again" })} data-testid="app-deployment-publish">
              {isBusy ? "Publishing…" : behindVersion === null ? "Publish again" : `Publish version ${behindVersion}`}
            </Button>
          {/snippet}
          {#snippet body()}
            <p class="m-0 text-[13px] leading-5 text-pretty text-(--solus-text-secondary)">
              {behindVersion === null
                ? "The copy has the active version. Publish again after you change a secret of the app."
                : `Version ${behindVersion} is active in Solus, and the copy runs version ${view.version}. A deploy in Solus does not reach the copy.`}
            </p>
          {/snippet}
        </SettingsRow>

        {#if view.address && view.link}
          {@const link = view.link}
          <SettingsRow label="Address" description={addressNote ?? (view.access === "link" ? "Give a person the link: it is the address with the secret that opens the app." : undefined)} testId="app-deployment-address">
            {#snippet control()}
              <span class="min-w-0 truncate font-mono text-[13px] text-foreground select-text" title={view.address}>{deploymentAddressText(view.address ?? "")}</span>
              <CopyButton text={link} title={view.access === "link" ? "Copy the link" : "Copy the address"} iconOnly refocusInput={false} />
              <Button size="icon-xs" variant="ghost" class="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:tap-area" title="Open the app" aria-label="Open the app in a browser" onclick={() => void localApi.openExternal(link)}>
                <OpenIcon size={14} />
              </Button>
            {/snippet}
          </SettingsRow>
        {/if}

        <SettingsRow label="Who opens it" description={deploymentAccessText(view.access)}>
          {#snippet control()}
            <SettingsSelect
              ariaLabel="Who opens the app"
              options={DEPLOYMENT_ACCESS_OPTIONS}
              value={view.access}
              disabled={isBusy}
              onSelect={(access) => {
                if (access === view.access) return;
                // The list of before comes back with the access that uses it.
                change(access === "people" ? { kind: "people", subjects: view.subjects } : { kind: "access", access });
              }}
            />
          {/snippet}
        </SettingsRow>
        {#if view.access !== "people" && !places.canNamePeople}
          <p class="m-0 px-4 pb-3.5 text-xs text-muted-foreground text-pretty">To name people, sign in to Solus on the host of the app.</p>
        {/if}

        {#if hasOneVisitorRole(view.access)}
          <SettingsRow label="What a visitor does" description={deploymentRoleText(view.role)}>
            {#snippet control()}
              <SettingsSelect
                ariaLabel="What a visitor does"
                options={DEPLOYMENT_ROLE_OPTIONS}
                value={view.role}
                disabled={isBusy}
                onSelect={(role) => {
                  if (role !== view.role) change({ kind: "role", role });
                }}
              />
            {/snippet}
          </SettingsRow>
        {:else}
          {@const draft = subjectsDraft ?? view.subjects}
          <SettingsRow label="People" description="A change holds for a person at their next sign-in, in half a day at most." testId="app-deployment-people-row">
            {#snippet control()}
              {#if subjectsDraft !== null && !sameSubjects(subjectsDraft, view.subjects)}
                <Button size="sm" variant="ghost" class="text-(--solus-text-secondary)" disabled={isBusy} onclick={() => (subjectsDraft = null)}>Cancel</Button>
                <Button size="sm" disabled={isBusy} onclick={() => change({ kind: "people", subjects: draft })} data-testid="app-deployment-people-save">{isBusy ? "Saving…" : "Save"}</Button>
              {/if}
            {/snippet}
            {#snippet body()}
              <DeploymentPeople subjects={draft} {directory} {ownerKey} disabled={isBusy} onChange={(next) => (subjectsDraft = next)} />
            {/snippet}
          </SettingsRow>
        {/if}

        {#if view.access === "link"}
          <SettingsRow label="New link" description="The old link stops, and each visitor who came in with it is out.">
            {#snippet control()}
              <Button size="sm" variant="outline" disabled={isBusy} onclick={() => change({ kind: "new-link" })} data-testid="app-deployment-new-link">New link</Button>
            {/snippet}
          </SettingsRow>
        {/if}

        {#each view.webhooks as webhook (webhook.name)}
          <SettingsRow label="Webhook: {webhook.name}" description="Where another service sends this webhook to the copy. The signing secret is the one in Webhooks.">
            {#snippet control()}
              <span class="min-w-0 truncate font-mono text-[13px] text-foreground select-text" title={webhook.url}>{deploymentAddressText(webhook.url)}</span>
              <CopyButton text={webhook.url} title="Copy the URL" iconOnly refocusInput={false} />
            {/snippet}
          </SettingsRow>
        {/each}

        {#if offersTailscaleAddress(view.platform)}
          <SettingsRow label="Tailscale address" description={view.host || places.hasTailscaleKey || view.tailscaleAddress ? "An address on your tailnet, with HTTPS, that your other devices open." : "An address on your tailnet. This host has no Tailscale auth key: set it in Settings, on the host's page."}>
            {#snippet control()}
              <Switch
                checked={view.tailscaleAddress}
                disabled={isBusy || (!view.host && !places.hasTailscaleKey && !view.tailscaleAddress)}
                aria-label="Tailscale address"
                onCheckedChange={(isOn) => change({ kind: "tailscale", isOn })}
              />
            {/snippet}
          </SettingsRow>

          <SettingsRow label="Log" description="The newest lines that the container wrote." bodyVisible={isLogOpen}>
            {#snippet control()}
              {#if isLogOpen}
                <Button size="sm" variant="ghost" class="text-(--solus-text-secondary)" onclick={() => void appsStore.deploymentLog.load(serverId, app.id)}>Read again</Button>
              {/if}
              <Button size="sm" variant="outline" aria-expanded={isLogOpen} onclick={() => (isLogOpen = !isLogOpen)} data-testid="app-deployment-log-toggle">{isLogOpen ? "Hide" : "Show"}</Button>
            {/snippet}
            {#snippet body()}
              {#if log !== undefined}
                {#if log}
                  <pre class="m-0 max-h-96 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre select-text" data-testid="app-deployment-log">{log}</pre>
                {:else}
                  <p class="m-0 text-xs text-muted-foreground">The container wrote no text.</p>
                {/if}
              {:else if logError}
                <p class="m-0 text-xs text-destructive" role="alert">{logError}</p>
              {:else}
                <p class="m-0 text-xs text-muted-foreground" role="status" aria-busy="true">Loading the log…</p>
              {/if}
            {/snippet}
          </SettingsRow>
        {/if}
      </SettingsSection>

      <SettingsSection>
        <SettingsRow label="Unpublish" description="Removes the copy with the data it holds. The app in Solus does not change.">
          {#snippet control()}
            <Button size="sm" variant="ghost" class="text-destructive hover:bg-destructive/10 hover:text-destructive" disabled={isBusy} onclick={() => void unpublish()} data-testid="app-deployment-unpublish">Unpublish</Button>
          {/snippet}
        </SettingsRow>
      </SettingsSection>
    {:else}
      <SettingsSection>
        {@const placeProblem = deploymentPlaceProblem(places.places, choices)}
        <SettingsRow label="Where it runs" description={placeProblem ?? "The copy runs in a container of its own, with its own data."}>
          {#snippet control()}
            <SettingsSelect ariaLabel="Where the copy runs" options={placeOptions} value={deploymentPlaceValue(choices)} disabled={isBusy} onSelect={(value) => Object.assign(choices, deploymentPlaceOf(value))} />
          {/snippet}
        </SettingsRow>

        {#if offersTailscaleAddress(choices.platform)}
          {@const lacksKey = choices.hostId === null && !places.hasTailscaleKey}
          <SettingsRow
            label="Tailscale address"
            description={lacksKey
              ? "An address on your tailnet. This host has no Tailscale auth key: set it in Settings, on the host's page."
              : "An address on your tailnet, with HTTPS, that your other devices open. Without it, the address opens only on the host that runs the container."}
          >
            {#snippet control()}
              <Switch checked={choices.tailscaleAddress && !lacksKey} disabled={isBusy || lacksKey} aria-label="Tailscale address" onCheckedChange={(isOn) => (choices.tailscaleAddress = isOn)} />
            {/snippet}
          </SettingsRow>
        {/if}

        <SettingsRow
          label="Who opens it"
          description={choices.access === "people" && !places.canNamePeople ? "To name people, sign in to Solus on the host of the app." : deploymentAccessText(choices.access)}
          bodyVisible={choices.access === "people"}
        >
          {#snippet control()}
            <SettingsSelect ariaLabel="Who opens the app" options={DEPLOYMENT_ACCESS_OPTIONS} value={choices.access} disabled={isBusy} onSelect={(access) => (choices.access = access)} />
          {/snippet}
          {#snippet body()}
            <DeploymentPeople subjects={choices.subjects} {directory} {ownerKey} disabled={isBusy} onChange={(next) => (choices.subjects = next)} />
          {/snippet}
        </SettingsRow>

        {#if hasOneVisitorRole(choices.access)}
          <SettingsRow label="What a visitor does" description={deploymentRoleText(choices.role)}>
            {#snippet control()}
              <SettingsSelect ariaLabel="What a visitor does" options={DEPLOYMENT_ROLE_OPTIONS} value={choices.role} disabled={isBusy} onSelect={(role) => (choices.role = role)} />
            {/snippet}
          </SettingsRow>
        {/if}
      </SettingsSection>

      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="sm"
          disabled={isBusy || app.activeVersion === null || deploymentPlaceProblem(places.places, choices) !== null || (choices.access === "people" && !places.canNamePeople)}
          onclick={() => void publish(firstPublishRequest(app.id, choices))}
          data-testid="app-deployment-publish"
        >
          {isBusy ? "Publishing…" : app.activeVersion === null ? "Publish" : `Publish version ${app.activeVersion}`}
        </Button>
        <span class="min-w-0 text-[13px] text-(--solus-text-secondary) text-pretty">
          {app.activeVersion === null
            ? "This app has no active version. Deploy one, then publish it."
            : "The app in Solus does not change. The copy gets the secrets of the app, and none of your connections."}
        </span>
      </div>
    {/if}
  </div>
</ManageSectionState>
