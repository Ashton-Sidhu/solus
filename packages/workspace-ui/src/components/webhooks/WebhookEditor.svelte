<script lang="ts">
  /** The webhook editor (docs/plans/webhooks.md §3): name, project, verification,
   *  replay key, and one to ten actions. The parent owns the draft and the save. */
  import { untrack } from "svelte";
  import { Plus as PlusIcon } from "@lucide/svelte";
  import { WEBHOOK_MAX_ACTIONS, type WebhookVerificationScheme } from "@solus/contracts/webhooks";
  import { getWorkspaceContext } from "../../contexts";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import WebhookVerificationFields from "./WebhookVerificationFields.svelte";
  import WebhookActionFields from "./WebhookActionFields.svelte";
  import { emptyActionDraft, type WebhookDraft } from "./lib/webhook-draft";

  let {
    draft = $bindable(),
    serverId,
    storedScheme = null,
    isNew = false,
    disabled = false,
  }: {
    draft: WebhookDraft;
    serverId: string;
    /** The saved scheme; null for a new webhook. */
    storedScheme?: WebhookVerificationScheme | null;
    isNew?: boolean;
    disabled?: boolean;
  } = $props();

  const session = getWorkspaceContext();
  $effect(() => {
    const hostId = serverId;
    return untrack(() => session.automationsStore.watchHost(hostId));
  });
  const automations = $derived(session.automationsStore.itemsForHost(serverId));
</script>

<div class="flex flex-col gap-5">
  <div class="flex flex-wrap gap-3">
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Name</span>
      <Input bind:value={draft.name} {disabled} class="h-7 w-64" aria-label="Webhook name" />
    </label>
    <label class="flex min-w-64 flex-1 flex-col gap-1">
      <span class="text-xs text-muted-foreground">Project folder on the host (optional)</span>
      <Input bind:value={draft.project} {disabled} class="h-7 font-mono text-xs" aria-label="Project folder" />
    </label>
    {#if isNew}
      <label class="flex items-center gap-2 self-end pb-1 text-sm">
        <Switch bind:checked={draft.enabled} {disabled} aria-label="Active" />
        Active
      </label>
    {/if}
  </div>

  <section class="flex flex-col gap-2">
    <h3 class="text-sm font-medium">Verification</h3>
    <WebhookVerificationFields
      bind:verification={draft.verification}
      hasStoredSecret={storedScheme !== null && storedScheme === draft.verification.scheme}
      {disabled}
    />
  </section>

  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">Replay key (optional). A second delivery with the same key starts nothing. For example {"{{headers.x-github-delivery}}"}.</span>
    <Input bind:value={draft.replayKey} {disabled} class="h-7 font-mono text-xs" aria-label="Replay key" />
  </label>

  <section class="flex flex-col gap-2">
    <h3 class="text-sm font-medium">Actions</h3>
    {#each draft.actions as action, index (action.id)}
      <WebhookActionFields
        bind:action={draft.actions[index]}
        {index}
        {automations}
        {disabled}
        onRemove={draft.actions.length > 1 ? () => draft.actions.splice(index, 1) : undefined}
      />
    {/each}
    {#if draft.actions.length < WEBHOOK_MAX_ACTIONS}
      <Button size="xs" variant="ghost" class="self-start" {disabled} onclick={() => draft.actions.push(emptyActionDraft(crypto.randomUUID()))}>
        <PlusIcon size={14} /> Add action
      </Button>
    {/if}
  </section>
</div>
