<script lang="ts">
  import { untrack } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { Input } from "../ui/input";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    ChevronDown as CaretDownIcon,
    Folder as FolderIcon,
    ChevronRight as CaretRightIcon,
    RotateCcw as ArrowCounterClockwiseIcon,
  } from "@lucide/svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import { abbreviateHome } from "../../lib/paths";
  import {
    APP_FONT_FAMILIES,
    APP_CODE_FONT_FAMILIES,
    DOCUMENT_FONT_FAMILIES,
  } from "../../contexts/app/settings.context.svelte";
  import {
    connectionsStore,
    getAgentContext,
    getSettingsContext,
    getTextGenerationSettingsStore,
    getWorkspaceContext,
  } from "../../contexts";
  import {
    defaultModelIdFor,
    modelOptionsFor,
  } from "../pickers/lib/picker-selection";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Switch } from "../ui/switch";
  import { Button } from "../ui/button";
  import SegmentedControl from "../ui/SegmentedControl.svelte";
  import SessionChip from "../pickers/SessionChip.svelte";
  import type { PickerSelection } from "../pickers/lib/picker-selection";
  import SettingsSection from "./SettingsSection.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import type {
    AgentTaskLifecyclePolicy,
    TextGenerationModelSelection,
  } from "@solus/contracts/types";

  interface Props {
    searchQuery?: string;
    serverId: string;
    api: HostApi;
    hostLabel: string;
  }

  let { searchQuery = "", serverId, api, hostLabel }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const session = getWorkspaceContext();
  const textGenerationSettingsStore = getTextGenerationSettingsStore();

  const textGenerationSnapshot = $derived(
    textGenerationSettingsStore.snapshotFor(serverId),
  );
  const textGenerationError = $derived(
    textGenerationSettingsStore.errorFor(serverId),
  );
  let textGenerationPickerSelection = $state<PickerSelection>();
  let backupTextGenerationPickerSelection = $state<PickerSelection>();

  $effect(() => {
    const targetServerId = serverId;
    const targetApi = api;
    untrack(() => {
      void connectionsStore.refreshCapabilities({
        serverId: targetServerId,
        api: targetApi,
      });
      void textGenerationSettingsStore
        .load({ serverId: targetServerId, api: targetApi })
        .catch(() => {});
    });
  });

  $effect(() => {
    const selection = textGenerationSnapshot?.textGenerationModel;
    if (!selection) return;
    if (!textGenerationPickerSelection) {
      textGenerationPickerSelection = {
        provider: selection.provider,
        modelId: selection.model,
        reasoningEffort: "high",
        fastMode: false,
      };
      return;
    }
    textGenerationPickerSelection.provider = selection.provider;
    textGenerationPickerSelection.modelId = selection.model;
  });

  $effect(() => {
    const selection = textGenerationSnapshot?.backupTextGenerationModel;
    if (!selection) return;
    if (!backupTextGenerationPickerSelection) {
      backupTextGenerationPickerSelection = {
        provider: selection.provider,
        modelId: selection.model,
        reasoningEffort: "high",
        fastMode: false,
      };
      return;
    }
    backupTextGenerationPickerSelection.provider = selection.provider;
    backupTextGenerationPickerSelection.modelId = selection.model;
  });

  const themeModes = [
    { value: "light" as const, label: "Light" },
    { value: "dark" as const, label: "Dark" },
    { value: "system" as const, label: "System" },
  ];

  const rateLimitStrats: [string, string][] = [
    ["ask", "Ask"],
    ["queue", "Queue"],
    ["stop", "Stop"],
    ["continue", "Continue"],
  ];

  const taskLifecyclePolicies: Array<{
    value: AgentTaskLifecyclePolicy;
    label: string;
  }> = [
    { value: "none", label: "None" },
    { value: "moderate", label: "Moderate" },
    { value: "autonomous", label: "Autonomous" },
  ];

  // Live metadata wins over the static profiles; the stored choice is only
  // honored while it still belongs to this agent, otherwise the agent default
  // shows in the shared model picker.
  const defaultAgentModels = $derived(
    modelOptionsFor(theme.activeAgent, agentContext.metadata),
  );
  const defaultModelId = $derived(
    defaultAgentModels.some(
      (model) => model.id === theme.defaultModels[theme.activeAgent],
    )
      ? theme.defaultModels[theme.activeAgent]
      : (defaultModelIdFor(theme.activeAgent, agentContext.metadata) ?? ""),
  );
  let defaultAgentModelPickerSelection = $state<PickerSelection>({
    provider: theme.activeAgent,
    modelId: null,
    reasoningEffort: "high",
    fastMode: false,
  });

  $effect(() => {
    defaultAgentModelPickerSelection.provider = theme.activeAgent;
    defaultAgentModelPickerSelection.modelId = defaultModelId;
  });

  let projectsBasePickerOpen = $state(false);

  // Per-host, not per-client: the folder picker on this server starts here.
  const projectsBaseDirectory = $derived(
    connectionsStore.capabilities?.projectsBaseDirectory ?? "",
  );

  async function commitProjectsBaseDirectory(next: string) {
    projectsBasePickerOpen = false;
    await connectionsStore.setProjectsBaseDirectory(serverId, next);
    requestInputFocus();
  }

  const appFontLabel = $derived(
    APP_FONT_FAMILIES.find((font) => font.id === theme.fontFamily)?.label ??
      "System",
  );
  const codeFontLabel = $derived(
    APP_CODE_FONT_FAMILIES.find((font) => font.id === theme.codeFontFamily)
      ?.label ?? "System",
  );
  const documentFontLabel = $derived(
    DOCUMENT_FONT_FAMILIES.find((font) => font.id === theme.documentFontFamily)
      ?.label ?? "Solus preset",
  );
  const rateLimitLabel = $derived(
    theme.rateLimitBehavior.at(0)?.toUpperCase() +
      theme.rateLimitBehavior.slice(1),
  );
  const taskLifecyclePolicy = $derived(
    connectionsStore.capabilitiesFor(serverId)?.agentTaskLifecyclePolicy,
  );
  const taskLifecyclePolicyLabel = $derived(
    taskLifecyclePolicies.find((option) => option.value === taskLifecyclePolicy)
      ?.label ?? "Unavailable",
  );

  function selectDefaultAgentModel(selection: PickerSelection) {
    session.setDefaultAgent(selection.provider);
    if (selection.modelId) {
      session.setDefaultModel(selection.provider, selection.modelId);
    }
  }

  function textGenerationModelLabel(
    selection: TextGenerationModelSelection | null | undefined,
  ): string {
    if (!selection) return "Loading…";
    const agent = textGenerationSnapshot?.agents.find(
      (candidate) => candidate.id === selection.provider,
    );
    const model = agent?.models.find(
      (candidate) => candidate.id === selection.model,
    );
    return `${agent?.label ?? selection.provider} · ${model?.label ?? selection.model}`;
  }

  function isSameTextGenerationModel(
    left: TextGenerationModelSelection | null | undefined,
    right: TextGenerationModelSelection | null | undefined,
  ): boolean {
    return (
      !!left &&
      !!right &&
      left.provider === right.provider &&
      left.model === right.model
    );
  }

  async function selectTextGenerationModel(
    selection: PickerSelection,
  ): Promise<void> {
    if (!selection.modelId) return;
    await textGenerationSettingsStore
      .update(
        { serverId, api },
        {
          textGenerationModel: {
            provider: selection.provider,
            model: selection.modelId,
          },
        },
      )
      .catch(() => {});
  }

  async function selectBackupTextGenerationModel(
    selection: PickerSelection,
  ): Promise<void> {
    if (!selection.modelId) return;
    await textGenerationSettingsStore
      .update(
        { serverId, api },
        {
          backupTextGenerationModel: {
            provider: selection.provider,
            model: selection.modelId,
          },
        },
      )
      .catch(() => {});
  }

  function selectAppFont(value: typeof theme.fontFamily) {
    theme.update({ fontFamily: value });
    requestInputFocus();
  }

  function selectCodeFont(value: typeof theme.codeFontFamily) {
    theme.update({ codeFontFamily: value });
    requestInputFocus();
  }

  function selectDocumentFont(value: typeof theme.documentFontFamily) {
    theme.update({ documentFontFamily: value });
    requestInputFocus();
  }

  function selectRateLimitBehavior(
    value: "ask" | "continue" | "stop" | "queue",
  ) {
    theme.update({ rateLimitBehavior: value });
    requestInputFocus();
  }

  function commitCompletedRetentionDays(value: number) {
    const days = Number.isFinite(value)
      ? Math.max(1, Math.min(365, Math.floor(value)))
      : theme.sidebarCompletedRetentionDays;
    theme.update({ sidebarCompletedRetentionDays: days });
  }

  async function selectTaskLifecyclePolicy(value: AgentTaskLifecyclePolicy) {
    await connectionsStore.setAgentTaskLifecyclePolicy(value, {
      serverId,
      api,
    });
    requestInputFocus();
  }

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    {
      id: "theme",
      keywords: ["dark", "theme", "light", "appearance", "mode", "system"],
    },
    {
      id: "agent-model",
      keywords: [
        "agent",
        "model",
        "default",
        "claude",
        "codex",
        "opus",
        "sonnet",
        "haiku",
        "gpt",
        "ai",
      ],
    },
    {
      id: "text-generation-model",
      keywords: [
        "model",
        "text",
        "generation",
        "background",
        "session",
        "name",
        "metadata",
        "writing",
      ],
    },
    {
      id: "backup-text-generation-model",
      keywords: [
        "backup",
        "fallback",
        "model",
        "text",
        "generation",
        "unavailable",
        "haiku",
      ],
    },
    {
      id: "notification",
      keywords: ["notification", "sound", "alert", "bell", "audio"],
    },
    {
      id: "font-family",
      keywords: [
        "font",
        "family",
        "typeface",
        "inter",
        "dm sans",
        "system",
        "geist",
        "lora",
        "serif",
      ],
    },
    { id: "font-size", keywords: ["font", "size", "text", "zoom"] },
    {
      id: "code-font-family",
      keywords: [
        "code",
        "font",
        "mono",
        "monospace",
        "diff",
        "typeface",
        "sf mono",
        "geist",
        "fira",
        "jetbrains",
        "cascadia",
      ],
    },
    {
      id: "code-font-size",
      keywords: ["code", "font", "size", "mono", "diff"],
    },
    {
      id: "document-font-family",
      keywords: [
        "document",
        "plan",
        "editor",
        "font",
        "family",
        "typeface",
        "writing",
        "prose",
      ],
    },
    {
      id: "document-font-size",
      keywords: [
        "document",
        "plan",
        "editor",
        "font",
        "size",
        "writing",
        "prose",
      ],
    },
    {
      id: "ratelimit",
      keywords: ["rate", "limit", "behavior", "queue", "throttle"],
    },
    {
      id: "task-lifecycle",
      keywords: [
        "agent",
        "task",
        "ticket",
        "lifecycle",
        "status",
        "done",
        "autonomous",
        "moderate",
      ],
    },
    {
      id: "completed-retention",
      keywords: [
        "task",
        "completed",
        "done",
        "sidebar",
        "history",
        "days",
        "retention",
      ],
    },
    {
      id: "projects-base",
      keywords: [
        "project",
        "projects",
        "folder",
        "directory",
        "base",
        "start",
        "open",
        "picker",
        "path",
      ],
    },
    {
      id: "auto-rename",
      keywords: [
        "rename",
        "name",
        "title",
        "session",
        "tab",
        "auto",
        "summarize",
      ],
    },
    {
      id: "turn-diff-summary",
      keywords: ["diff", "summary", "changed", "files", "turn", "transcript"],
    },
    {
      id: "analytics",
      keywords: ["analytics", "telemetry", "tracking", "privacy", "data"],
    },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));
</script>

<SettingsSection
  label="Appearance"
  visible={[
    "theme",
    "font-family",
    "font-size",
    "code-font-family",
    "code-font-size",
    "document-font-family",
    "document-font-size",
  ].some(isVisible)}
>
  <SettingsRow
    label="Theme"
    description="Match your system appearance, or pin light or dark."
    visible={isVisible("theme")}
  >
    {#snippet control()}
      <SegmentedControl
        options={themeModes}
        isActive={(value) => theme.themeMode === value}
        onSelect={(value) => theme.update({ themeMode: value })}
        ariaLabel="Theme"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Interface font"
    description="The typeface used across the app."
    visible={isVisible("font-family")}
  >
    {#snippet control()}
      <DropdownMenu.Root
        onOpenChange={(next) => {
          if (!next) requestInputFocus();
        }}
      >
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label="Interface font"
              class="min-w-28 justify-between text-xs shadow-xs"
            >
              <span class="truncate">{appFontLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[176px]"
        >
          <DropdownMenu.RadioGroup value={theme.fontFamily}>
            {#each APP_FONT_FAMILIES as font (font.id)}
              <DropdownMenu.RadioItem
                value={font.id}
                onSelect={() => selectAppFont(font.id)}
              >
                <span class="truncate">{font.label}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Interface size"
    description="Text size in conversations and panels."
    visible={isVisible("font-size")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-border bg-card shadow-xs [.is-laptop-display_&]:h-6"
      >
        <button
          type="button"
          onclick={() =>
            theme.update({ fontSize: Math.max(8, theme.fontSize - 1) })}
          aria-label="Decrease interface size"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >&minus;</button
        >
        <Input
          type="number"
          min={8}
          step={1}
          value={String(theme.fontSize)}
          aria-label="Interface size in pixels"
          onchange={(e) => {
            const v = Math.max(8, Number((e.target as HTMLInputElement).value));
            theme.update({ fontSize: v });
            (e.target as HTMLInputElement).value = String(v);
          }}
          class="h-auto w-9 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">px</span>
        <button
          type="button"
          onclick={() => theme.update({ fontSize: theme.fontSize + 1 })}
          aria-label="Increase interface size"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Document font"
    description="The typeface used in document and plan editors."
    visible={isVisible("document-font-family")}
  >
    {#snippet control()}
      <DropdownMenu.Root
        onOpenChange={(next) => {
          if (!next) requestInputFocus();
        }}
      >
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label="Document font"
              class="min-w-28 justify-between text-xs shadow-xs"
            >
              <span class="truncate">{documentFontLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[176px]"
        >
          <DropdownMenu.RadioGroup value={theme.documentFontFamily}>
            {#each DOCUMENT_FONT_FAMILIES as font (font.id)}
              <DropdownMenu.RadioItem
                value={font.id}
                onSelect={() => selectDocumentFont(font.id)}
              >
                <span class="truncate">{font.label}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Document size"
    description="Text size in document and plan editors."
    visible={isVisible("document-font-size")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-border bg-card shadow-xs [.is-laptop-display_&]:h-6"
      >
        <button
          type="button"
          onclick={() =>
            theme.update({
              documentFontSize: Math.max(12, theme.documentFontSize - 1),
            })}
          aria-label="Decrease document size"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >&minus;</button
        >
        <Input
          type="number"
          min={12}
          step={1}
          value={String(theme.documentFontSize)}
          aria-label="Document size in pixels"
          onchange={(e) => {
            const v = Math.max(
              12,
              Number((e.target as HTMLInputElement).value),
            );
            theme.update({ documentFontSize: v });
            (e.target as HTMLInputElement).value = String(v);
          }}
          class="h-auto w-9 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">px</span>
        <button
          type="button"
          onclick={() =>
            theme.update({ documentFontSize: theme.documentFontSize + 1 })}
          aria-label="Increase document size"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Code font"
    description="Monospace typeface used in diffs and code blocks."
    visible={isVisible("code-font-family")}
  >
    {#snippet control()}
      <DropdownMenu.Root
        onOpenChange={(next) => {
          if (!next) requestInputFocus();
        }}
      >
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label="Code font"
              class="min-w-28 justify-between text-xs shadow-xs"
            >
              <span class="truncate">{codeFontLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[192px]"
        >
          <DropdownMenu.RadioGroup value={theme.codeFontFamily}>
            {#each APP_CODE_FONT_FAMILIES as font (font.id)}
              <DropdownMenu.RadioItem
                value={font.id}
                onSelect={() => selectCodeFont(font.id)}
              >
                <span class="truncate">{font.label}</span>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Code font size"
    description="Text size in diffs and code blocks."
    visible={isVisible("code-font-size")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-border bg-card shadow-xs [.is-laptop-display_&]:h-6"
      >
        <button
          type="button"
          onclick={() =>
            theme.update({ codeFontSize: Math.max(8, theme.codeFontSize - 1) })}
          aria-label="Decrease code font size"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >&minus;</button
        >
        <Input
          type="number"
          min={8}
          step={1}
          value={String(theme.codeFontSize)}
          aria-label="Code font size in pixels"
          onchange={(e) => {
            const v = Math.max(8, Number((e.target as HTMLInputElement).value));
            theme.update({ codeFontSize: v });
            (e.target as HTMLInputElement).value = String(v);
          }}
          class="h-auto w-9 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">px</span>
        <button
          type="button"
          onclick={() => theme.update({ codeFontSize: theme.codeFontSize + 1 })}
          aria-label="Increase code font size"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  label="Agents & sessions"
  visible={[
    "agent-model",
    "ratelimit",
    "task-lifecycle",
    "completed-retention",
    "notification",
  ].some(isVisible)}
>
  <SettingsRow
    label="Default agent and model"
    description="The agent and model used for new sessions."
    visible={isVisible("agent-model")}
  >
    {#snippet control()}
      <SessionChip
        selection={defaultAgentModelPickerSelection}
        modelOnly
        menuSide="bottom"
        ariaLabel="Default agent and model"
        returnFocusOnClose
        class="min-w-48"
        onSelectionChange={selectDefaultAgentModel}
      />
    {/snippet}
  </SettingsRow>
  <SettingsRow
    label="Task lifecycle control"
    description="None blocks status changes. Moderate reserves Done for you. Autonomous gives agents full control."
    visible={isVisible("task-lifecycle")}
  >
    {#snippet control()}
      <DropdownMenu.Root
        onOpenChange={(next) => {
          if (!next) requestInputFocus();
        }}
      >
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label="Task lifecycle control"
              class="min-w-28 justify-between text-xs shadow-xs"
              disabled={taskLifecyclePolicy === undefined ||
                connectionsStore.agentTaskLifecyclePolicyUpdating}
            >
              <span>{taskLifecyclePolicyLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[160px]"
        >
          <DropdownMenu.RadioGroup value={taskLifecyclePolicy}>
            {#each taskLifecyclePolicies as option (option.value)}
              <DropdownMenu.RadioItem
                value={option.value}
                onSelect={() => selectTaskLifecyclePolicy(option.value)}
              >
                {option.label}
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
    {#if taskLifecyclePolicy === undefined}
      {#snippet body()}
        <p class="text-xs text-muted-foreground">
          This host does not expose task lifecycle controls. Reconnect it after
          updating Solus.
        </p>
      {/snippet}
    {/if}
  </SettingsRow>

  <SettingsRow
    label="Completed task history"
    description="Keep completed tasks in the session sidebar for this many days."
    visible={isVisible("completed-retention")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-border bg-card shadow-xs [.is-laptop-display_&]:h-6"
      >
        <button
          type="button"
          onclick={() =>
            commitCompletedRetentionDays(
              theme.sidebarCompletedRetentionDays - 1,
            )}
          aria-label="Decrease completed task history"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >&minus;</button
        >
        <Input
          type="number"
          min={1}
          max={365}
          step={1}
          value={String(theme.sidebarCompletedRetentionDays)}
          aria-label="Completed task history in days"
          onchange={(event) => {
            commitCompletedRetentionDays(
              Number((event.target as HTMLInputElement).value),
            );
            (event.target as HTMLInputElement).value = String(
              theme.sidebarCompletedRetentionDays,
            );
          }}
          class="h-auto w-9 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">d</span>
        <button
          type="button"
          onclick={() =>
            commitCompletedRetentionDays(
              theme.sidebarCompletedRetentionDays + 1,
            )}
          aria-label="Increase completed task history"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [.is-laptop-display_&]:px-2"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Rate limit behavior"
    description="What happens when a run hits a provider rate limit."
    visible={isVisible("ratelimit")}
  >
    {#snippet control()}
      <DropdownMenu.Root
        onOpenChange={(next) => {
          if (!next) requestInputFocus();
        }}
      >
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="outline"
              size="sm"
              aria-label="Rate limit behavior"
              class="min-w-24 justify-between text-xs shadow-xs"
            >
              <span>{rateLimitLabel}</span>
              <CaretDownIcon size={11} style="opacity:0.6" />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={6}
          class="w-[144px]"
        >
          <DropdownMenu.RadioGroup value={theme.rateLimitBehavior}>
            {#each rateLimitStrats as [val, label] (val)}
              <DropdownMenu.RadioItem
                value={val}
                onSelect={() =>
                  selectRateLimitBehavior(
                    val as "ask" | "continue" | "stop" | "queue",
                  )}
              >
                {label}
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Notifications"
    description="Show an alert and play a sound when a session needs you."
    visible={isVisible("notification")}
  >
    {#snippet control()}
      <Switch
        checked={theme.soundEnabled}
        onCheckedChange={(next) => theme.update({ soundEnabled: next })}
        size="default"
        aria-label="Toggle notifications"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  label="Text generation"
  visible={isVisible("text-generation-model") ||
    isVisible("backup-text-generation-model")}
>
  <SettingsRow
    label="Text-generation model"
    description="The {hostLabel} host uses this model for session names and short background writing."
    visible={isVisible("text-generation-model")}
  >
    {#snippet control()}
      {#if textGenerationPickerSelection && textGenerationSnapshot}
        <SessionChip
          selection={textGenerationPickerSelection}
          agents={textGenerationSnapshot.agents}
          modelOnly
          menuSide="bottom"
          ariaLabel="Text-generation model"
          returnFocusOnClose
          class="min-w-40"
          onSelectionChange={(selection) =>
            void selectTextGenerationModel(selection)}
        />
      {:else}
        <Button
          variant="outline"
          size="sm"
          disabled
          class="min-w-40 text-xs shadow-xs"
        >
          Loading…
        </Button>
      {/if}
    {/snippet}
    {#if textGenerationError || (textGenerationSnapshot && !isSameTextGenerationModel(textGenerationSnapshot.textGenerationModel, textGenerationSnapshot.effectiveTextGenerationModel))}
      {#snippet body()}
        {#if textGenerationError}
          <p class="text-xs text-destructive" role="alert">
            {textGenerationError}
          </p>
        {:else if textGenerationSnapshot}
          <p class="text-xs text-muted-foreground">
            The saved model is not available on this host. Solus currently uses {textGenerationModelLabel(
              textGenerationSnapshot.effectiveTextGenerationModel,
            )}.
          </p>
        {/if}
      {/snippet}
    {/if}
  </SettingsRow>

  <SettingsRow
    label="Backup text-generation model"
    description="Used when the text-generation model is not available on the {hostLabel} host."
    visible={isVisible("backup-text-generation-model")}
  >
    {#snippet control()}
      {#if backupTextGenerationPickerSelection && textGenerationSnapshot}
        <SessionChip
          selection={backupTextGenerationPickerSelection}
          agents={textGenerationSnapshot.agents}
          modelOnly
          menuSide="bottom"
          ariaLabel="Backup text-generation model"
          returnFocusOnClose
          class="min-w-40"
          onSelectionChange={(selection) =>
            void selectBackupTextGenerationModel(selection)}
        />
      {:else}
        <Button
          variant="outline"
          size="sm"
          disabled
          class="min-w-40 text-xs shadow-xs"
        >
          Loading…
        </Button>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  label="Workspace"
  visible={["projects-base", "auto-rename", "turn-diff-summary"].some(
    isVisible,
  )}
>
  <SettingsRow
    label="Projects folder"
    description="Where “Open project” looks, and where clones land. Leave empty to use your home folder."
    visible={isVisible("projects-base")}
  >
    {#snippet control()}
      <div class="flex items-center gap-1">
        <!-- Reset sits left of the trigger so the trigger's right edge stays flush
             with every other row's control; opacity-0 keeps it holding its slot. -->
        <Button
          variant="ghost"
          size="icon-sm"
          class="text-(--solus-text-tertiary) disabled:opacity-0"
          disabled={!projectsBaseDirectory}
          aria-label="Reset projects start folder"
          title="Reset to home folder"
          onclick={() => commitProjectsBaseDirectory("")}
        >
          <ArrowCounterClockwiseIcon size={14} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Projects start in"
          class="w-56 justify-between text-xs shadow-xs {projectsBaseDirectory
            ? ''
            : 'text-muted-foreground'}"
          onclick={() => (projectsBasePickerOpen = true)}
        >
          <FolderIcon
            size={13}
            weight="fill"
            class="shrink-0 text-muted-foreground"
          />
          <span class="flex-1 truncate text-left"
            >{projectsBaseDirectory
              ? abbreviateHome(projectsBaseDirectory)
              : "~/"}</span
          >
          <CaretRightIcon size={11} style="opacity:0.6" />
        </Button>
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Name sessions automatically"
    description="Summarize the first prompt into a short session name."
    visible={isVisible("auto-rename")}
  >
    {#snippet control()}
      <Switch
        checked={theme.autoRenameSessions}
        onCheckedChange={(next) => theme.update({ autoRenameSessions: next })}
        size="default"
        aria-label="Toggle automatic session naming"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Show changed files after turns"
    description="Render a compact diff summary at the end of completed turns."
    visible={isVisible("turn-diff-summary")}
  >
    {#snippet control()}
      <Switch
        checked={theme.showDiffSummaryAfterTurn}
        onCheckedChange={(next) =>
          theme.update({ showDiffSummaryAfterTurn: next })}
        size="default"
        aria-label="Toggle changed files summaries after turns"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection label="Privacy" visible={isVisible("analytics")}>
  <SettingsRow
    label="Share anonymous analytics"
    description="Help improve Solus with anonymous usage data."
  >
    {#snippet control()}
      <Switch
        checked={theme.analyticsEnabled}
        onCheckedChange={(next) => theme.update({ analyticsEnabled: next })}
        size="default"
        aria-label="Toggle analytics"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

{#if !anyVisible}
  <div
    class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary) [.is-laptop-display_&]:py-6"
  >
    No settings match your search
  </div>
{/if}

<DirectoryPicker
  bind:open={projectsBasePickerOpen}
  onClose={() => {
    projectsBasePickerOpen = false;
    requestInputFocus();
  }}
  onSelect={commitProjectsBaseDirectory}
  initialPath={projectsBaseDirectory || undefined}
  title="Projects start in"
  actionLabel="Start here"
  {api}
  {serverId}
/>
