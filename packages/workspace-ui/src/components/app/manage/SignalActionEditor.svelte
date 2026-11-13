<script lang="ts">
  import type { Automation } from "@solus/contracts/types";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import { Switch } from "../../ui/switch";
  import { Textarea } from "../../ui/textarea";
  import SettingsSelect from "../../settings/SettingsSelect.svelte";
  import {
    SIGNAL_ACTION_TYPES,
    SIGNAL_AGENT_LIMIT_TEXT,
    SIGNAL_EMPTY_TEMPLATE_TEXT,
    SIGNAL_NEW_SESSION_TEXT,
    SIGNAL_PROMPT_WARNING,
    SIGNAL_TEMPLATE_HELP,
    signalActionTypeLabel,
    type SignalActionDraft,
  } from "./lib/signal-actions";

  /**
   * The fields of one signal action (docs/plans/apps.md §8.4): a notification
   * has a title and a detail; a prompt to a session and a run of an automation
   * have a prompt template.
   */
  interface Props {
    draft: SignalActionDraft;
    /** The automations of the app's host, for `run_automation`. */
    automations: Automation[];
    /** Why the last save was refused; null when nothing was. */
    error: string | null;
    disabled: boolean;
    saveLabel: string;
    onSave: () => void;
    onCancel: () => void;
  }
  let { draft = $bindable(), automations, error, disabled, saveLabel, onSave, onCancel }: Props = $props();

  const typeChoices = SIGNAL_ACTION_TYPES.map((type) => ({ value: type, label: signalActionTypeLabel(type) }));
  // A saved automation stays a choice while the list loads, or after it was deleted.
  const automationChoices = $derived([
    { value: "", label: "Choose" },
    ...(draft.automationId && !automations.some((automation) => automation.id === draft.automationId) ? [{ value: draft.automationId, label: draft.automationId }] : []),
    ...automations.map((automation) => ({ value: automation.id, label: automation.name })),
  ]);
</script>

<div class="flex min-w-0 flex-col gap-3 rounded-lg border border-border/60 p-3" data-testid="app-signal-action-editor">
  <div class="flex flex-wrap items-center gap-2">
    <SettingsSelect compact ariaLabel="Action type" options={typeChoices} value={draft.type} {disabled} onSelect={(type) => (draft.type = type)} />
    <label class="ml-1 flex items-center gap-2 text-sm">
      <Switch bind:checked={draft.enabled} {disabled} aria-label="Action on" />
      On
    </label>
  </div>

  {#if draft.type === "notify"}
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Title (empty uses the name of the signal)</span>
      <Input bind:value={draft.title} {disabled} class="h-7" aria-label="Title template" />
    </label>
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Detail</span>
      <Input bind:value={draft.detail} {disabled} class="h-7" aria-label="Detail template" />
    </label>
    <p class="m-0 text-xs text-muted-foreground text-pretty">{SIGNAL_TEMPLATE_HELP}</p>
  {:else}
    {#if draft.type === "send_to_session"}
      <label class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Session ID</span>
        <Input bind:value={draft.sessionId} {disabled} class="h-7 font-mono text-xs" aria-label="Session ID" />
      </label>
    {:else}
      <div class="flex flex-col gap-1">
        <span class="text-xs text-muted-foreground">Automation</span>
        <div class="flex">
          <SettingsSelect compact ariaLabel="Automation" options={automationChoices} value={draft.automationId} {disabled} onSelect={(automationId) => (draft.automationId = automationId)} />
        </div>
        <span class="text-xs text-muted-foreground text-pretty">{SIGNAL_NEW_SESSION_TEXT}</span>
      </div>
    {/if}
    <label class="flex flex-col gap-1">
      <span class="text-xs text-muted-foreground">Prompt template</span>
      <Textarea bind:value={draft.template} {disabled} rows={4} class="font-mono text-xs" aria-label="Prompt template" />
      <span class="text-xs text-muted-foreground text-pretty">{SIGNAL_TEMPLATE_HELP} {SIGNAL_EMPTY_TEMPLATE_TEXT}</span>
      <span class="text-xs text-muted-foreground text-pretty">{SIGNAL_PROMPT_WARNING} {SIGNAL_AGENT_LIMIT_TEXT}</span>
    </label>
  {/if}

  {#if error}
    <p class="m-0 text-xs text-destructive" role="alert">{error}</p>
  {/if}
  <div class="flex flex-wrap gap-2">
    <Button size="xs" {disabled} onclick={onSave}>{saveLabel}</Button>
    <Button size="xs" variant="outline" {disabled} onclick={onCancel}>Cancel</Button>
  </div>
</div>
