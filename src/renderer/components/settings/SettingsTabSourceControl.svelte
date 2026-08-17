<script lang="ts">
  import { tick, untrack } from "svelte";
  import { CaretDownIcon } from "phosphor-svelte";
  import type { HostApi } from "@client-core/host-api";
  import {
    DEFAULT_SOURCE_CONTROL_WRITING,
    type SourceControlWritingMode,
    type SourceControlWritingPreferences,
    type TextGenerationModelSelection,
  } from "../../../shared/types";
  import { getTextGenerationSettingsStore } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Switch } from "../ui/switch";
  import { Textarea } from "../ui/textarea";
  import * as TooltipUI from "../ui/tooltip";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsSection from "./SettingsSection.svelte";

  interface Props {
    serverId: string;
    api: HostApi;
  }

  interface ModelOption extends TextGenerationModelSelection {
    key: string;
    label: string;
  }

  let { serverId, api }: Props = $props();
  let customInstructionsElement = $state<HTMLTextAreaElement | null>(null);
  let customInstructionsDraft = $state("");
  let customInstructionsSource = $state<string | null>(null);

  const settingsStore = getTextGenerationSettingsStore();
  const snapshot = $derived(settingsStore.snapshotFor(serverId));
  const style = $derived(snapshot?.sourceControlWriting ?? DEFAULT_SOURCE_CONTROL_WRITING);
  const error = $derived(settingsStore.errorFor(serverId));
  const modelOptions = $derived.by((): ModelOption[] => {
    if (!snapshot) return [];
    return snapshot.agents
      .filter((agent) => agent.available !== false)
      .flatMap((agent) => agent.models.map((model) => ({
        provider: agent.id,
        model: model.id,
        key: `${agent.id}:${model.id}`,
        label: `${agent.label} · ${model.label}`,
      })));
  });

  const styleOptions = {
    repo_conventions: {
      label: "Repository conventions",
      description: "Match the writing patterns in each repository's recent commit messages.",
    },
    conventional_commits: {
      label: "Conventional Commits",
      description: "Use prefixes such as feat:, fix:, and docs: for commits. Pull-request titles stay plain language.",
    },
    custom: {
      label: "Custom instructions",
      description: "Use your saved instructions for commit messages, branch names, and pull requests.",
    },
  } satisfies Record<SourceControlWritingMode, { label: string; description: string }>;

  $effect(() => {
    const targetServerId = serverId;
    const targetApi = api;
    untrack(() => {
      void settingsStore.load({ serverId: targetServerId, api: targetApi }).catch(() => {});
    });
  });

  $effect(() => {
    const savedInstructions = style.customInstructions;
    if (savedInstructions === customInstructionsSource) return;
    customInstructionsDraft = savedInstructions;
    customInstructionsSource = savedInstructions;
  });

  function modelLabel(selection: TextGenerationModelSelection | null | undefined): string {
    if (!selection) return "Use text-generation model";
    const option = modelOptions.find(
      (candidate) => candidate.provider === selection.provider && candidate.model === selection.model,
    );
    if (option) return option.label;
    const agent = snapshot?.agents.find((candidate) => candidate.id === selection.provider);
    const model = agent?.models.find((candidate) => candidate.id === selection.model);
    return `${agent?.label ?? selection.provider} · ${model?.label ?? selection.model}`;
  }

  function isSameModel(
    left: TextGenerationModelSelection | null | undefined,
    right: TextGenerationModelSelection | null | undefined,
  ): boolean {
    return !!left && !!right && left.provider === right.provider && left.model === right.model;
  }

  async function update(
    patch: Parameters<HostApi["textGenerationSettingsUpdate"]>[0],
  ): Promise<void> {
    await settingsStore.update({ serverId, api }, patch).catch(() => {});
    requestInputFocus();
  }

  function saveStyle(next: SourceControlWritingPreferences): Promise<void> {
    return update({ sourceControlWriting: next });
  }

  async function selectStyle(mode: SourceControlWritingMode): Promise<void> {
    await saveStyle({ ...style, mode });
    if (mode !== "custom") return;
    await tick();
    customInstructionsElement?.focus({ preventScroll: true });
  }

  function setFollowTemplates(enabled: boolean): void {
    void saveStyle({ ...style, followPullRequestTemplate: enabled });
  }

  function saveCustomInstructions(): void {
    const value = customInstructionsDraft.trim();
    if (value === style.customInstructions) return;
    void saveStyle({ ...style, customInstructions: value });
  }

  async function setDedicatedWriter(enabled: boolean): Promise<void> {
    if (!snapshot) return;
    await update({
      sourceControlWriterModel: enabled ? snapshot.effectiveTextGenerationModel : null,
    });
  }

  function selectWriterModel(option: ModelOption): void {
    void update({
      sourceControlWriterModel: { provider: option.provider, model: option.model },
    });
  }
</script>

<SettingsSection label="Text generation">
  <SettingsRow
    label="Source control writing style"
    description={styleOptions[style.mode].description}
    bodyVisible={style.mode === "custom"}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus(); }}>
        <DropdownMenu.Trigger disabled={!snapshot}>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" class="min-w-48 justify-between text-xs shadow-xs" aria-label="Source control writing style">
              <span class="truncate">{styleOptions[style.mode].label}</span>
              <CaretDownIcon size={11} class="opacity-60" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[240px]">
          <DropdownMenu.RadioGroup value={style.mode}>
            {#each Object.entries(styleOptions) as [mode, option] (mode)}
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props })}
                    <DropdownMenu.RadioItem
                      {...props}
                      value={mode}
                      onSelect={() => selectStyle(mode as SourceControlWritingMode)}
                    >
                      {option.label}
                    </DropdownMenu.RadioItem>
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content value={option.description} side="left" />
              </TooltipUI.Root>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
    {#snippet body()}
      <div class="space-y-2">
        <Textarea
          bind:ref={customInstructionsElement}
          bind:value={customInstructionsDraft}
          rows={4}
          maxlength={8000}
          autofocus
          placeholder="Keep titles concise. Use short bullet points in descriptions."
          aria-label="Custom source-control writing instructions"
        />
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="min-w-52 flex-1 text-pretty text-xs text-muted-foreground">
            These instructions apply to every project on this host and stay saved if you change styles.
          </p>
          <Button
            size="sm"
            disabled={!snapshot || customInstructionsDraft.trim() === style.customInstructions}
            onclick={saveCustomInstructions}
          >
            Save instructions
          </Button>
        </div>
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Follow pull-request templates"
    description="Structure pull-request descriptions with the current repository template when one is available."
  >
    {#snippet control()}
      <Switch
        checked={style.followPullRequestTemplate}
        disabled={!snapshot}
        onCheckedChange={setFollowTemplates}
        aria-label="Follow pull-request templates"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Source-control writer model"
    description="Optional model override for commits, pull requests, and branch names. Off uses the global text-generation model."
  >
    {#snippet control()}
      <div class="flex flex-wrap items-center justify-end gap-2">
        {#if snapshot?.sourceControlWriterModel}
          <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus(); }}>
            <DropdownMenu.Trigger disabled={modelOptions.length === 0}>
              {#snippet child({ props })}
                <Button {...props} variant="outline" size="sm" class="max-w-64 min-w-32 justify-between text-xs shadow-xs" aria-label="Source-control writer model">
                  <span class="truncate">{modelLabel(snapshot.sourceControlWriterModel)}</span>
                  <CaretDownIcon size={11} class="opacity-60" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[240px]">
              <DropdownMenu.RadioGroup value={`${snapshot.sourceControlWriterModel.provider}:${snapshot.sourceControlWriterModel.model}`}>
                {#each modelOptions as option (option.key)}
                  <DropdownMenu.RadioItem value={option.key} onSelect={() => selectWriterModel(option)}>
                    <span class="truncate">{option.label}</span>
                  </DropdownMenu.RadioItem>
                {/each}
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        {/if}
        <Switch
          checked={snapshot?.sourceControlWriterModel !== null && snapshot?.sourceControlWriterModel !== undefined}
          disabled={!snapshot}
          onCheckedChange={setDedicatedWriter}
          aria-label="Use a separate source-control writer model"
        />
      </div>
    {/snippet}
    {#if snapshot?.sourceControlWriterModel && !isSameModel(snapshot.sourceControlWriterModel, snapshot.effectiveSourceControlWriterModel)}
      {#snippet body()}
        <p class="text-xs text-muted-foreground">
          The saved writer is unavailable. Solus currently uses {modelLabel(snapshot.effectiveSourceControlWriterModel)}.
        </p>
      {/snippet}
    {/if}
  </SettingsRow>
</SettingsSection>

{#if error}
  <p class="text-xs text-destructive" role="alert">{error}</p>
{/if}
