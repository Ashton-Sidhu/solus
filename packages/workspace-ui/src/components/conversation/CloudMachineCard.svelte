<script lang="ts">
  /** The machine card of a cloud machine tool (plans/035-cloud-machine-tools.md §6).
   *  It shows what the agent asks for, the person opens the fields and chooses,
   *  and the card answers with `respondQuestion`. The tool on the host makes the
   *  change; the card makes no account call. */
  import { untrack } from "svelte";
  import { TriangleAlert as WarningIcon } from "@lucide/svelte";
  import { cloudMachineAnswers, type CloudMachineAsk } from "@solus/contracts/cloud-machine-card";
  import type { QuestionRequest } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { runHost } from "../../contexts/workspace/run-location";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { newCloudHostLabel } from "../onboarding/lib/cloud-compute";
  import CloudMachineFields from "../fleet/CloudMachineFields.svelte";
  import { Button } from "../ui/button";
  import * as Select from "../ui/select";
  import InterruptCard from "./InterruptCard.svelte";
  import {
    cloudMachineCardTitle,
    cloudMachineFacts,
    cloudMachineReviewLabel,
    cloudMachineSubmit,
    cloudMachineSubmitLabel,
    initialCloudMachineForm,
    restartsMachine,
  } from "./lib/cloud-machine-card";

  interface Props {
    tabId: string;
    request: QuestionRequest;
    ask: CloudMachineAsk;
    /** Answers another session's card. Unset, the answer goes to this tab's session. */
    answer?: (questionId: string, answers: Record<string, string>) => Promise<boolean>;
  }
  let { tabId, request, ask, answer }: Props = $props();

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const canDrive = $derived(canDriveSession(runHost(sess?.run), sess?.id, "drive.approve"));
  const idBase = $derived(`cloud-machine-${request.questionId}`);

  // The card is keyed by its question, so the ask does not change under the form.
  const form = $state(untrack(() => initialCloudMachineForm(ask)));
  let phase = $state<"choose" | "sending" | "closed">("choose");
  let didFail = $state(false);
  // Join has no step before its fields: the address and the organization are the whole choice.
  let isReviewing = $state(untrack(() => ask.mode === "join"));

  const facts = $derived(cloudMachineFacts(ask));
  const submit = $derived(cloudMachineSubmit(ask, form));
  const organizations = $derived(ask.mode === "edit" ? [] : ask.organizations);
  const chosenOrganization = $derived(organizations.find((organization) => organization.id === form.organizationId) ?? null);
  const showsOrganizationChoice = $derived(organizations.length > 1);
  // A missing organization shows on its own control; a problem with no control to fix it shows as text.
  const problem = $derived(!submit.ok && (submit.field !== "organization" || !showsOrganizationChoice) ? submit.problem : null);
  const isBusy = $derived(phase !== "choose");
  const closed = $derived(!!request.expired || phase === "closed" || !canDrive);
  const reviewLabel = $derived(cloudMachineReviewLabel(ask));

  async function send(answers: Record<string, string>): Promise<void> {
    if (closed || isBusy) return;
    phase = "sending";
    didFail = false;
    const answered = await (answer
      ? answer(request.questionId, answers)
      : session.controls.respondQuestion(tabId, request.questionId, answers)
    ).catch(() => false);
    phase = answered ? "closed" : "choose";
    didFail = !answered;
    if (answered) requestInputFocus({ tabId });
  }

  function choose() {
    if (submit.ok) void send(submit.answers);
  }
</script>

<InterruptCard type="question" title={cloudMachineCardTitle(ask)} testId="cloud-machine-card">
  <form
    id="{idBase}-form"
    class="flex min-w-0 flex-col gap-3"
    autocomplete="off"
    onsubmit={(event) => { event.preventDefault(); choose(); }}
  >
    <p class="interrupt-title m-0 wrap-anywhere">{ask.reason}</p>

    {#if request.expired}
      <p class="m-0 text-transcript-meta text-(--muted-foreground)">This request is closed.</p>
    {:else}
      <!-- The facts give way to the fields. A join card has no step between: its facts stay. -->
      {#if !isReviewing || ask.mode === "join"}
        <dl class="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-transcript-meta">
          {#each facts as fact (fact.label)}
            <dt class="text-(--muted-foreground)">{fact.label}</dt>
            <dd class={["m-0 min-w-0 wrap-anywhere", fact.isMissing ? "font-medium text-(--warning)" : "text-(--solus-text-primary)"]}>{fact.value}</dd>
          {/each}
        </dl>
      {/if}

      {#if restartsMachine(ask)}
        <div class="flex min-w-0 items-start gap-2 rounded-lg bg-[color-mix(in_oklch,var(--warning)_10%,transparent)] px-3 py-2 text-transcript-meta text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]">
          <WarningIcon size={14} class="mt-0.5 shrink-0" />
          <p class="m-0 min-w-0 text-pretty">The machine restarts to take the change. Its sessions stop.</p>
        </div>
      {/if}

      {#if isReviewing}
        {#if showsOrganizationChoice}
          <div class="flex min-w-0 flex-col gap-1.5">
            <span id="{idBase}-organization-label" class="text-[0.8125rem] text-(--solus-text-secondary)">Organization</span>
            <Select.Root type="single" value={form.organizationId} onValueChange={(value) => (form.organizationId = value)} disabled={closed || isBusy}>
              <Select.Trigger aria-labelledby="{idBase}-organization-label" class="w-full min-w-0 text-workspace-chrome">
                {#if chosenOrganization}<span class="truncate">{chosenOrganization.name}</span>{:else}<span class="truncate text-(--warning)">Choose one</span>{/if}
              </Select.Trigger>
              <Select.Content class="text-workspace-chrome">
                {#each organizations as organization (organization.id)}
                  <Select.Item value={organization.id} label={organization.name} />
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {/if}
        {#if ask.mode === "create"}
          <CloudMachineFields
            catalog={ask.catalog}
            bind:name={form.name}
            bind:sizeId={form.sizeId}
            bind:packages={form.packages}
            bind:setupScript={form.setupScript}
            namePlaceholder={newCloudHostLabel(chosenOrganization)}
            disabled={closed || isBusy}
            packagesInvalid={!submit.ok && submit.field === "packages"}
            setupScriptInvalid={!submit.ok && submit.field === "setupScript"}
          />
        {:else if ask.mode === "edit"}
          <CloudMachineFields
            setupOnly
            bind:packages={form.packages}
            bind:setupScript={form.setupScript}
            disabled={closed || isBusy}
            packagesInvalid={!submit.ok && submit.field === "packages"}
            setupScriptInvalid={!submit.ok && submit.field === "setupScript"}
          />
        {/if}
        {#if problem}<p role="alert" class="m-0 text-transcript-meta text-pretty text-(--solus-status-error)">{problem}</p>{/if}
      {/if}

      {#if didFail}<p role="alert" class="m-0 text-transcript-meta text-(--solus-status-error)">The answer did not reach the agent. Try again.</p>{/if}
    {/if}
  </form>
  {#snippet footer()}
    {#if !request.expired}
      <div class="flex min-w-0 items-center justify-end gap-1">
        {#if !canDrive}
          <span class="text-transcript-meta text-(--muted-foreground)">Waiting for an editor</span>
        {:else}
          <Button size="sm" variant="ghost" disabled={closed || isBusy} onclick={() => void send(cloudMachineAnswers({ status: "declined" }))}>Decline</Button>
          {#if isReviewing || !reviewLabel}
            <Button size="sm" type="submit" form="{idBase}-form" disabled={closed || isBusy || !submit.ok} class="min-w-0 max-w-64">
              <span class="truncate">{cloudMachineSubmitLabel(ask)}</span>
            </Button>
          {:else}
            <Button size="sm" disabled={closed || isBusy} onclick={() => (isReviewing = true)} class="min-w-0 max-w-64">
              <span class="truncate">{reviewLabel}</span>
            </Button>
          {/if}
        {/if}
      </div>
    {/if}
  {/snippet}
</InterruptCard>
