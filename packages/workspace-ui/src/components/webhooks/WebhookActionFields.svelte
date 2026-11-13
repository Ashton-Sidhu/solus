<script lang="ts">
  /** One action of a webhook (docs/plans/webhooks.md §3.1, §3.2): its type and
   *  fields, up to 16 filters that must all match, and its prompt template. */
  import { Plus as PlusIcon, Trash2 as TrashIcon } from "@lucide/svelte";
  import { WEBHOOK_MAX_FILTERS } from "@solus/contracts/webhooks";
  import type { Automation } from "@solus/contracts/types";
  import type { AppSummary } from "@solus/contracts/apps";
  import { untrack } from "svelte";
  import { appsStore } from "../../contexts/apps/apps.store.svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Textarea } from "../ui/textarea";
  import { Switch } from "../ui/switch";
  import SettingsSelect from "../settings/SettingsSelect.svelte";
  import { actionTypeLabel } from "./lib/webhooks-view";
  import { appMutationNames, FILTER_OPS, filterOpLabel, REASONING_EFFORTS, type ActionDraft } from "./lib/webhook-draft";

  let {
    action = $bindable(),
    index,
    serverId,
    automations,
    apps,
    disabled = false,
    onRemove,
  }: {
    action: ActionDraft;
    index: number;
    /** The webhook's host: an action runs there. */
    serverId: string;
    /** The automations of the webhook's host, for `run_automation`. */
    automations: Automation[];
    /** The apps of the webhook's host, for `call_app`. */
    apps: AppSummary[];
    disabled?: boolean;
    onRemove?: () => void;
  } = $props();

  const typeChoices: { value: ActionDraft["type"]; label: string }[] = [
    { value: "", label: "Choose" },
    ...(["start_session", "send_to_session", "run_automation", "call_app"] as const).map((type) => ({ value: type, label: actionTypeLabel(type) })),
  ];
  const providerChoices: { value: ActionDraft["agentProvider"]; label: string }[] = [
    { value: "", label: "Choose" },
    { value: "claude-code", label: "Claude Code" },
    { value: "codex", label: "Codex" },
  ];
  const effortChoices: { value: ActionDraft["reasoningEffort"]; label: string }[] = [
    { value: "", label: "Choose" },
    ...REASONING_EFFORTS.map((effort) => ({ value: effort, label: effort })),
  ];
  const opChoices: { value: ActionDraft["filters"][number]["op"]; label: string }[] = [
    { value: "", label: "Choose" },
    ...FILTER_OPS.map((op) => ({ value: op, label: filterOpLabel(op) })),
  ];
  const automationChoices = $derived([
    { value: "", label: "Choose" },
    ...automations.map((automation) => ({ value: automation.id, label: automation.name })),
  ]);
  const appChoices = $derived([
    { value: "", label: "Choose" },
    ...apps.map((app) => ({ value: app.id, label: app.name })),
  ]);
  // The mutations come from the descriptor of the chosen app's active version.
  $effect(() => {
    const hostId = serverId;
    const appId = action.type === "call_app" ? action.appId : "";
    if (appId) untrack(() => appsStore.ensureState(hostId, appId));
  });
  const mutations = $derived(action.appId ? appMutationNames(appsStore.stateFor(serverId, action.appId)?.descriptor) : []);
  // A saved operation stays a choice while the descriptor loads, or after a deploy removed it.
  const operationChoices = $derived([
    { value: "", label: "Choose" },
    ...(action.operation && !mutations.includes(action.operation) ? [action.operation] : []).concat(mutations).map((name) => ({ value: name, label: name })),
  ]);
</script>

<div class="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
  <div class="flex flex-wrap items-end gap-2">
    <span class="mr-1 self-center text-sm font-medium">Action {index + 1}</span>
    <SettingsSelect compact ariaLabel="Action {index + 1} type" options={typeChoices} value={action.type} {disabled} onSelect={(type) => (action.type = type)} />
    <label class="ml-2 flex items-center gap-2 self-center text-sm">
      <Switch bind:checked={action.enabled} {disabled} aria-label="Action {index + 1} on" />
      On
    </label>
    {#if onRemove}
      <Button size="icon-xs" variant="ghost" class="ml-auto" aria-label="Remove action {index + 1}" {disabled} onclick={onRemove}>
        <TrashIcon size={14} />
      </Button>
    {/if}
  </div>

  {#if action.type === "start_session"}
    <div class="flex flex-wrap items-end gap-2">
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Agent</span>
        <SettingsSelect compact ariaLabel="Agent" options={providerChoices} value={action.agentProvider} {disabled} onSelect={(provider) => (action.agentProvider = provider)} />
      </div>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Model (empty uses the default)</span>
        <Input bind:value={action.modelId} {disabled} class="h-7 w-48" aria-label="Model" />
      </label>
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Reasoning effort</span>
        <SettingsSelect compact ariaLabel="Reasoning effort" options={effortChoices} value={action.reasoningEffort} {disabled} onSelect={(effort) => (action.reasoningEffort = effort)} />
      </div>
    </div>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Project folder on the host</span>
      <Input bind:value={action.cwd} {disabled} class="h-7 font-mono text-xs" aria-label="Project folder" />
    </label>
    <label class="flex items-center gap-2 text-sm">
      <Switch bind:checked={action.useWorktree} {disabled} aria-label="Use a new worktree" />
      Use a new worktree
    </label>
  {:else if action.type === "send_to_session"}
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Session ID</span>
      <Input bind:value={action.sessionId} {disabled} class="h-7 font-mono text-xs" aria-label="Session ID" />
    </label>
  {:else if action.type === "run_automation"}
    <div class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Automation</span>
      <SettingsSelect compact ariaLabel="Automation" options={automationChoices} value={action.automationId} {disabled} onSelect={(automationId) => (action.automationId = automationId)} />
    </div>
  {:else if action.type === "call_app"}
    <div class="flex flex-wrap items-end gap-2">
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">App</span>
        <SettingsSelect
          compact
          ariaLabel="App"
          options={appChoices}
          value={action.appId}
          {disabled}
          onSelect={(appId) => {
            if (appId !== action.appId) action.operation = "";
            action.appId = appId;
          }}
        />
      </div>
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Mutation</span>
        <SettingsSelect compact ariaLabel="Mutation" options={operationChoices} value={action.operation} disabled={disabled || !action.appId} onSelect={(operation) => (action.operation = operation)} />
      </div>
    </div>
    <span class="text-xs text-muted-foreground">The mutation gets the headers, the query, and the body of the request as its input.</span>
  {/if}

  <div class="flex flex-col gap-2">
    <span class="text-xs text-muted-foreground">
      Filters. All must match. With no filters, the action runs for every delivery. A path is like headers.x-github-event or body.labels[].name.
    </span>
    {#each action.filters as filter, filterIndex (filterIndex)}
      <div class="flex flex-wrap items-center gap-2">
        <Input bind:value={filter.path} {disabled} placeholder="Path" class="h-7 w-56 font-mono text-xs" aria-label="Filter {filterIndex + 1} path" />
        <SettingsSelect compact ariaLabel="Filter {filterIndex + 1} operator" options={opChoices} value={filter.op} {disabled} onSelect={(op) => (filter.op = op)} />
        {#if filter.op !== "exists"}
          <Input
            bind:value={filter.value}
            {disabled}
            placeholder={filter.op === "in" ? "Values, with commas" : "Value"}
            class="h-7 w-56 font-mono text-xs"
            aria-label="Filter {filterIndex + 1} value"
          />
        {/if}
        <Button size="icon-xs" variant="ghost" aria-label="Remove filter {filterIndex + 1}" {disabled} onclick={() => action.filters.splice(filterIndex, 1)}>
          <TrashIcon size={14} />
        </Button>
      </div>
    {/each}
    {#if action.filters.length < WEBHOOK_MAX_FILTERS}
      <Button size="xs" variant="ghost" class="self-start" {disabled} onclick={() => action.filters.push({ path: "", op: "", value: "" })}>
        <PlusIcon size={14} /> Add filter
      </Button>
    {/if}
  </div>

  {#if action.type !== "call_app"}
  <label class="flex flex-col gap-1">
    <span class="text-xs text-muted-foreground">
      Prompt template. Use {"{{body.path}}"}, {"{{headers.name}}"}, {"{{query.name}}"}, {"{{body}}"}, or {"{{request}}"}. Request text is not safe: the tags help the agent, but they do not make sure that it ignores the text.
    </span>
    <Textarea bind:value={action.template} {disabled} rows={4} class="font-mono text-xs" aria-label="Action {index + 1} template" />
  </label>
  {/if}
</div>
