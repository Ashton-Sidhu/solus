<script lang="ts">
  import { sourceControlWritingOptions } from "@solus/client-core/settings-source-control";
  import { sourceControlSettings } from "./lib/settings-search-data";
  import { settingVisible } from "@solus/client-core/settings-search";
  import { settingsDefinitions } from "@solus/client-core/settings-definitions";
  import { tick, untrack } from "svelte";
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import {
    DEFAULT_SOURCE_CONTROL_WRITING,
    type SourceControlWritingMode,
    type SourceControlWritingPreferences,
    type TextGenerationModelSelection,
  } from "@solus/contracts/types";
  import {
    accountStore,
    getSettingsContext,
    getTextGenerationSettingsStore,
    serversStore,
    sharesStore,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import GitHubConnect from "../connections/GitHubConnect.svelte";
  import AccountConnectionRow from "../seats/AccountConnectionRow.svelte";
  import { accountVaultStore } from "../seats/account-vault.store.svelte";
  import { cloudConnectionsPointerUrl } from "../seats/lib/cloud-connections";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Switch } from "../ui/switch";
  import { Textarea } from "../ui/textarea";
  import * as TooltipUI from "../ui/tooltip";
  import SettingsRow from "./SettingsRow.svelte";
  import { managedSetting } from "./policy/managed-setting.svelte";
  import SettingsSection from "./SettingsSection.svelte";
  import ProjectBranchNamingSetting from "./ProjectBranchNamingSetting.svelte";
  import ProjectCodebaseNamingSetting from "../codebases/ProjectCodebaseNamingSetting.svelte";
  import ProjectCopiedFilesSetting from "./ProjectCopiedFilesSetting.svelte";
  import WorktreeBranchNamingRow from "./WorktreeBranchNamingRow.svelte";
  import ManagedWorktreesSection from "./ManagedWorktreesSection.svelte";
  import { isModelOffered } from "./lib/text-generation-models";

  interface Props {
    serverId: string;
    api: HostApi;
    projectCwd?: string | null;
    searchQuery?: string;
  }

  interface ModelOption extends TextGenerationModelSelection {
    key: string;
    label: string;
  }

  let { serverId, api, projectCwd, searchQuery = "" }: Props = $props();
  const isVisible = (id: string) => settingVisible(searchQuery, sourceControlSettings, id);
  let customInstructionsElement = $state<HTMLTextAreaElement | null>(null);
  let customInstructionsDraft = $state("");
  let customInstructionsSource = $state<string | null>(null);

  // A signed-in person keeps their GitHub connection in their Solus account,
  // not on the host; the row shows the account's status and points there.
  $effect(() => {
    void accountStore.state;
    const targetServerId = serverId;
    untrack(() => {
      void sharesStore.identityFor(targetServerId, true).catch(() => {});
      void accountVaultStore.load();
    });
  });
  $effect(() => accountVaultStore.watch());
  const cloudConnectionsUrl = $derived(
    cloudConnectionsPointerUrl({
      identity: sharesStore.identities.get(serverId),
      directoryUrl: serversStore.servers.find((server) => server.id === serverId)?.uplink?.directoryUrl,
    }),
  );

  // The writing choices are the person's; the host only says which models it offers.
  const settings = getSettingsContext();
  const settingsStore = getTextGenerationSettingsStore();
  const snapshot = $derived(settingsStore.snapshotFor(serverId));
  const style = $derived(settings.sourceControlWriting ?? DEFAULT_SOURCE_CONTROL_WRITING);
  const writerModel = $derived(settings.sourceControlWriterModel);
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

  function saveStyle(next: SourceControlWritingPreferences): void {
    settings.setPersonal("sourceControlWriting", next);
    requestInputFocus();
  }

  async function selectStyle(mode: SourceControlWritingMode): Promise<void> {
    saveStyle({ ...style, mode });
    if (mode !== "custom") return;
    await tick();
    customInstructionsElement?.focus({ preventScroll: true });
  }

  function setFollowTemplates(enabled: boolean): void {
    saveStyle({ ...style, followPullRequestTemplate: enabled });
  }

  function saveCustomInstructions(): void {
    const value = customInstructionsDraft.trim();
    if (value === style.customInstructions) return;
    saveStyle({ ...style, customInstructions: value });
  }

  function setDedicatedWriter(enabled: boolean): void {
    settings.setPersonal("sourceControlWriterModel", enabled ? { ...settings.textGenerationModel } : null);
    requestInputFocus();
  }

  function selectWriterModel(option: ModelOption): void {
    settings.setPersonal("sourceControlWriterModel", { provider: option.provider, model: option.model });
    requestInputFocus();
  }
</script>

{#if projectCwd}
  <SettingsSection {...settingsDefinitions["source-control.section-project-worktrees"]} visible={isVisible("project-branch-names") || isVisible("project-codebase-names") || isVisible("copied-files")}>
    {#key `${serverId}:${projectCwd}`}
      <ProjectBranchNamingSetting {serverId} {api} cwd={projectCwd} />
      <ProjectCodebaseNamingSetting {serverId} {api} cwd={projectCwd} />
      <ProjectCopiedFilesSetting {serverId} cwd={projectCwd} />
    {/key}
  </SettingsSection>
{:else}

<SettingsSection {...settingsDefinitions["source-control.section-source-control-providers"]} visible={isVisible("github")}>
  {#if cloudConnectionsUrl}
    <AccountConnectionRow
      url={cloudConnectionsUrl}
      {...settingsDefinitions["source-control.github"]}
      status={accountVaultStore.providerStatus("github")}
      testId="source-control-row-github-account"
    />
  {:else}
    <GitHubConnect {serverId} />
  {/if}
</SettingsSection>

<SettingsSection {...settingsDefinitions["source-control.section-commits-pull-requests"]} visible={["writing", "templates", "writer-model"].some(isVisible)}>
  <SettingsRow
    {...settingsDefinitions["source-control.commit-and-pull-request-writing"]}
    visible={isVisible("writing")}
    managed={managedSetting("sourceControlWriting")}
    description={sourceControlWritingOptions[style.mode].description}
    bodyVisible={style.mode === "custom"}
  >
    {#snippet control()}
      <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus(); }}>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props} variant="outline" size="sm" class="min-w-48 justify-between text-xs font-normal shadow-xs" aria-label="Commit and pull request writing">
              <span class="truncate">{sourceControlWritingOptions[style.mode].label}</span>
              <CaretDownIcon size={11} class="opacity-60" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[240px]">
          <DropdownMenu.RadioGroup value={style.mode}>
            {#each Object.entries(sourceControlWritingOptions) as [mode, option] (mode)}
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
          placeholder="Keep pull request titles under 60 characters. Write pull request descriptions as short bullet points."
          aria-label="Custom commit and pull request instructions"
          class="bg-white! disabled:bg-white! dark:bg-input/30! dark:disabled:bg-input/30!"
        />
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="min-w-52 flex-1 text-pretty text-xs text-muted-foreground">
            These instructions apply to your work in every project and stay saved if you change styles.
          </p>
          <Button
            size="sm"
            disabled={customInstructionsDraft.trim() === style.customInstructions}
            onclick={saveCustomInstructions}
          >
            Save instructions
          </Button>
        </div>
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["source-control.follow-pull-request-templates"]}
    visible={isVisible("templates")}
  >
    {#snippet control()}
      <Switch
        checked={style.followPullRequestTemplate}
        onCheckedChange={setFollowTemplates}
        aria-label="Follow pull-request templates"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    {...settingsDefinitions["source-control.source-control-writer-model"]}
    visible={isVisible("writer-model")}
    managed={managedSetting("sourceControlWriterModel")}
    bodyVisible={!!writerModel && !!snapshot && !isModelOffered(snapshot.agents, writerModel)}
  >
    {#snippet control()}
      <div class="flex flex-wrap items-center justify-end gap-2">
        {#if writerModel}
          <DropdownMenu.Root onOpenChange={(next) => { if (!next) requestInputFocus(); }}>
            <DropdownMenu.Trigger disabled={modelOptions.length === 0}>
              {#snippet child({ props })}
                <Button {...props} variant="outline" size="sm" class="max-w-64 min-w-32 justify-between text-xs font-normal shadow-xs" aria-label="Source-control writer model">
                  <span class="truncate">{modelLabel(writerModel)}</span>
                  <CaretDownIcon size={11} class="opacity-60" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="bottom" align="end" sideOffset={6} class="w-[240px]">
              <DropdownMenu.RadioGroup value={`${writerModel.provider}:${writerModel.model}`}>
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
          checked={writerModel !== null}
          onCheckedChange={setDedicatedWriter}
          aria-label="Use a separate source-control writer model"
        />
      </div>
    {/snippet}
    {#snippet body()}
      {#if writerModel && snapshot}
        <p class="text-xs text-muted-foreground">
          This host does not offer {modelLabel(writerModel)}. Your choice stays saved; this host uses {modelLabel(snapshot.effectiveSourceControlWriterModel)}.
        </p>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection {...settingsDefinitions["source-control.section-worktrees"]} visible={isVisible("branch-names")}>
  <WorktreeBranchNamingRow
    {...settingsDefinitions["source-control.branch-names"]}
    managed={managedSetting("worktreeBranchNaming")}
    naming={settings.worktreeBranchNaming}
    onSave={(naming) => settings.setPersonal("worktreeBranchNaming", naming)}
    note="A project can override this in Settings, Projects."
  />
</SettingsSection>

<ManagedWorktreesSection
  {serverId}
  {api}
  {...settingsDefinitions["source-control.managed-worktrees"]}
  visible={isVisible("managed-worktrees")}
/>

{#if error}
  <p class="text-xs text-destructive" role="alert">{error}</p>
{/if}

{/if}
