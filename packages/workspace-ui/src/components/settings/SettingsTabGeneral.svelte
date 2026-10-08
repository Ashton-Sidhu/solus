<script module lang="ts">
  /** Search words, read by the settings page to find this page from any other. */
  export interface SettingItem {
    id: string;
    keywords: string[];
  }

  export const settingItems: SettingItem[] = [
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
        "auto",
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
      id: "default-permission",
      keywords: ["default", "permission", "supervised", "ask", "edits", "auto", "full", "access", "plan", "mode"],
    },
    {
      id: "response-streaming",
      keywords: ["response", "streaming", "paragraph", "buffered", "text"],
    },
    {
      id: "ratelimit",
      keywords: ["rate", "limit", "behavior", "queue", "throttle"],
    },
    {
      id: "sidebar-motion",
      keywords: [
        "sidebar",
        "animation",
        "motion",
        "speed",
        "duration",
        "slide",
        "fade",
        "ms",
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
      id: "show-tool-calls",
      keywords: ["tool", "calls", "steps", "activity", "transcript", "simple", "hide"],
    },
    {
      id: "collapse-composer",
      keywords: [
        "collapse",
        "composer",
        "input",
        "bar",
        "toolbar",
        "focus",
        "idle",
        "compact",
        "minimize",
      ],
    },
    {
      id: "model-routing",
      keywords: ["auto", "model", "routing", "jev", "interface", "exploration", "task", "general"],
    },
    {
      id: "about",
      keywords: ["about", "version", "update", "upgrade", "release", "notes", "restart"],
    },
  ];
</script>

<script lang="ts">
  import { Skeleton } from "../ui/skeleton";
  import { untrack } from "svelte";
  import type { ResponseStreamingMode } from "@solus/contracts/settings";
  import { MAX_SIDEBAR_MOTION_MS } from "@solus/contracts/settings";
  import { AUTO_MODEL_ID } from "@solus/contracts/model-routing";
  import { PERMISSION_MODES } from "@solus/contracts/types";
  import { PERMISSION_MODE_DISPLAY } from "../../lib/permission-modes";
  import type { HostApi } from "@solus/client-core/host-api";
  import { Input } from "../ui/input";
  import {
    Folder as FolderIcon,
    ChevronRight as CaretRightIcon,
    RotateCcw as ArrowCounterClockwiseIcon,
  } from "@lucide/svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import { abbreviateHome } from "../../lib/paths";
  import {
    connectionsStore,
    getAgentContext,
    getSettingsContext,
    getTextGenerationSettingsStore,
    getWorkspaceContext,
    hosts,
  } from "../../contexts";
  import {
    defaultModelIdFor,
    modelOptionsFor,
  } from "../pickers/lib/picker-selection";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { Switch } from "../ui/switch";
  import { Button } from "../ui/button";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SessionChip from "../pickers/SessionChip.svelte";
  import type { PickerSelection } from "../pickers/lib/picker-selection";
  import SettingsSection from "./SettingsSection.svelte";
  import RateLimitSetting from "./RateLimitSetting.svelte";
  import SettingsRow from "./SettingsRow.svelte";
  import SettingsAboutSection from "./SettingsAboutSection.svelte";
  import { isModelOffered } from "./lib/text-generation-models";
  import ModelRoutingSection from "./ModelRoutingSection.svelte";
  import { solusToolsStore } from "./solus-tools.store.svelte";
  import type { TextGenerationModelSelection } from "@solus/contracts/types";

  interface Props {
    searchQuery?: string;
    serverId: string;
    api: HostApi;
    hostLabel: string;
  }

  let { searchQuery = "", serverId, api, hostLabel }: Props = $props();

  const permissionModes = PERMISSION_MODES.map((value) => ({ value, label: PERMISSION_MODE_DISPLAY[value].label }));
  const responseStreamingModes = [
    { value: "buffered", label: "Buffered" },
    { value: "paragraph", label: "Streaming" },
  ] satisfies Array<{ value: ResponseStreamingMode; label: string }>;
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

  $effect(() => {
    const targetServerId = serverId;
    const targetApi = api;
    untrack(() => {
      // The projects folder and agent sign-in change outside this page: read them again on each visit.
      void hosts.get(targetServerId).refresh("capabilities");
      void textGenerationSettingsStore
        .load({ serverId: targetServerId, api: targetApi })
        .catch(() => {});
    });
  });

  // The choice is the person's; the host snapshot only says which models it offers.
  $effect(() => {
    const selection = theme.textGenerationModel;
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

  // Live metadata wins over the static profiles; the stored choice is only
  // honored while it still belongs to this agent, otherwise the agent default
  // shows in the shared model picker. Auto names no model of its own, so it is
  // honored for whichever agent it was stored against.
  const defaultAgentModels = $derived(
    modelOptionsFor(theme.activeAgent, agentContext.metadata),
  );
  const storedDefaultModelId = $derived(theme.defaultModels[theme.activeAgent]);
  const defaultModelId = $derived(
    storedDefaultModelId === AUTO_MODEL_ID ||
      defaultAgentModels.some((model) => model.id === storedDefaultModelId)
      ? storedDefaultModelId
      : (defaultModelIdFor(theme.activeAgent, agentContext.metadata) ?? ""),
  );
  const autoNeedsKey = $derived(
    defaultModelId === AUTO_MODEL_ID && solusToolsStore.isTypeSafeKeyMissing(serverId),
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

  // Per-host, not per-client: the folder this host really uses — the setting,
  // the managed host's volume, or ~/projects.
  const projectsBaseDirectory = $derived(
    hosts.get(serverId).capabilityRecord?.projectsBaseDirectory ?? "",
  );
  const projectsBaseDirectoryIsSet = $derived(
    hosts.get(serverId).capabilityRecord?.projectsBaseDirectoryIsSet === true,
  );

  async function commitProjectsBaseDirectory(next: string) {
    projectsBasePickerOpen = false;
    await connectionsStore.setProjectsBaseDirectory(serverId, next);
    requestInputFocus();
  }

  function selectDefaultAgentModel(selection: PickerSelection) {
    session.config.setDefaultAgent(selection.provider);
    if (selection.modelId) {
      session.config.setDefaultModel(selection.provider, selection.modelId);
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

  function selectTextGenerationModel(selection: PickerSelection): void {
    if (!selection.modelId) return;
    theme.setPersonal("textGenerationModel", {
      provider: selection.provider,
      model: selection.modelId,
    });
  }

  /** One press of the stepper: fine enough to tune by feel, coarse enough that
   *  the full range is a couple of dozen presses. */
  const SIDEBAR_MOTION_STEP_MS = 25;

  /** The settings context clamps the value; a field left empty keeps the
   *  current one rather than turning the motion off. */
  function commitSidebarMotionMs(value: number) {
    if (!Number.isFinite(value)) return;
    theme.setPersonal("sidebarMotionMs", value);
  }


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
  label="New sessions"
  visible={["agent-model", "default-permission"].some(isVisible)}
>
  <SettingsRow
    label="Default agent and model"
    description={autoNeedsKey
      ? "Auto needs a TypeSafe key in Tools. Until then, it uses General use."
      : "Agent and model for new sessions. Auto picks from the first prompt."}
    visible={isVisible("agent-model")}
  >
    {#snippet control()}
      <SessionChip
        selection={defaultAgentModelPickerSelection}
        {serverId}
        modelOnly
        allowAuto
        menuSide="bottom"
        ariaLabel="Default agent and model"
        returnFocusOnClose
        class="w-full @min-[30rem]/pane:w-56"
        onSelectionChange={selectDefaultAgentModel}
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Default permission mode"
    description="Mode for new sessions. Existing sessions keep theirs."
    visible={isVisible("default-permission")}
  >
    {#snippet control()}
      <SettingsSelect
        options={permissionModes}
        value={theme.defaultPermissionMode}
        onSelect={(value) => theme.setPersonal("defaultPermissionMode", value)}
        ariaLabel="Default permission mode"
      />
    {/snippet}
  </SettingsRow>
</SettingsSection>

<ModelRoutingSection {serverId} visible={isVisible("model-routing")} />

<SettingsSection
  label="Behavior"
  visible={[
    "response-streaming",
    "turn-diff-summary",
    "show-tool-calls",
    "collapse-composer",
    "auto-rename",
    "ratelimit",
    "sidebar-motion",
  ].some(isVisible)}
>
  <SettingsRow
    label="Sidebar animation"
    description="Sidebar task animation length. 0 turns it off."
    visible={isVisible("sidebar-motion")}
  >
    {#snippet control()}
      <div
        class="flex h-7 items-center overflow-hidden rounded-md border border-input bg-white shadow-xs/5 dark:bg-input/30"
      >
        <button
          type="button"
          onclick={() =>
            commitSidebarMotionMs(theme.sidebarMotionMs - SIDEBAR_MOTION_STEP_MS)}
          aria-label="Shorten sidebar animation"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >&minus;</button
        >
        <Input
          type="number"
          min={0}
          max={MAX_SIDEBAR_MOTION_MS}
          step={SIDEBAR_MOTION_STEP_MS}
          value={String(theme.sidebarMotionMs)}
          aria-label="Sidebar animation in milliseconds"
          onchange={(event) => {
            commitSidebarMotionMs(
              Number((event.target as HTMLInputElement).value),
            );
            (event.target as HTMLInputElement).value = String(
              theme.sidebarMotionMs,
            );
          }}
          class="h-auto w-10 rounded-none border-0 bg-transparent p-0 text-center text-xs font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="mr-1 text-xs text-(--solus-text-tertiary)">ms</span>
        <button
          type="button"
          onclick={() =>
            commitSidebarMotionMs(theme.sidebarMotionMs + SIDEBAR_MOTION_STEP_MS)}
          aria-label="Lengthen sidebar animation"
          class="h-full px-2.5 text-workspace-chrome text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >+</button
        >
      </div>
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Response streaming"
    description="Show paragraphs and code blocks as they finish, or wait for each segment."
    visible={isVisible("response-streaming")}
  >
    {#snippet control()}
      <SettingsSelect
        options={responseStreamingModes}
        value={theme.responseStreamingMode}
        onSelect={(value) => theme.setPersonal("responseStreamingMode", value)}
        ariaLabel="Response streaming"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Show changed files after turns"
    description="Show a diff summary after each turn."
    visible={isVisible("turn-diff-summary")}
  >
    {#snippet control()}
      <Switch
        checked={theme.showDiffSummaryAfterTurn}
        onCheckedChange={(next) =>
          theme.setPersonal("showDiffSummaryAfterTurn", next)}
        size="default"
        aria-label="Toggle changed files summaries after turns"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Show tool calls"
    description="Off shows only the agent's messages, questions, and cards."
    visible={isVisible("show-tool-calls")}
  >
    {#snippet control()}
      <Switch
        checked={theme.showToolCalls}
        onCheckedChange={(next) => theme.setPersonal("showToolCalls", next)}
        size="default"
        aria-label="Toggle tool calls in the transcript"
      />
    {/snippet}
  </SettingsRow>

  <SettingsRow
    label="Collapse the input bar when idle"
    description="Hide the toolbar until the input bar has focus."
    visible={isVisible("collapse-composer")}
  >
    {#snippet control()}
      <Switch
        checked={theme.collapseComposerWhenIdle}
        onCheckedChange={(next) =>
          theme.setPersonal("collapseComposerWhenIdle", next)}
        size="default"
        aria-label="Toggle collapsing the input bar when idle"
      />
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
        onCheckedChange={(next) => theme.setPersonal("autoRenameSessions", next)}
        size="default"
        aria-label="Toggle automatic session naming"
      />
    {/snippet}
  </SettingsRow>

  <RateLimitSetting visible={isVisible("ratelimit")} />
</SettingsSection>

<SettingsSection label="Projects" visible={isVisible("projects-base")}>
  <SettingsRow
    label="Projects folder"
    description="Where new projects are created and clones land."
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
          disabled={!projectsBaseDirectoryIsSet}
          aria-label="Reset projects folder"
          title="Reset to the default folder"
          onclick={() => commitProjectsBaseDirectory("")}
        >
          <ArrowCounterClockwiseIcon size={14} />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Projects folder"
          class="w-56 justify-between text-xs font-normal shadow-xs {projectsBaseDirectoryIsSet
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
              : "~/projects"}</span
          >
          <CaretRightIcon size={11} style="opacity:0.6" />
        </Button>
      </div>
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsSection
  label="Text generation"
  visible={isVisible("text-generation-model")}
>
  <SettingsRow
    label="Text-generation model"
    description="Session names and short background writing for your work."
    visible={isVisible("text-generation-model")}
    bodyVisible={!!textGenerationError || (!!textGenerationSnapshot && !isModelOffered(textGenerationSnapshot.agents, theme.textGenerationModel))}
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
          class="w-full @min-[30rem]/pane:w-56"
          onSelectionChange={selectTextGenerationModel}
        />
      {:else}
        <Button
          variant="outline"
          size="sm"
          disabled
          class="w-full @min-[30rem]/pane:w-56 text-xs shadow-xs"
        >
          <Skeleton class="h-3 w-24" aria-label="Loading settings" />
        </Button>
      {/if}
    {/snippet}
    {#snippet body()}
      {#if textGenerationError}
        <p class="text-xs text-destructive" role="alert">
          {textGenerationError}
        </p>
      {:else if textGenerationSnapshot}
        <p class="text-xs text-muted-foreground">
          {hostLabel} does not offer {textGenerationModelLabel(theme.textGenerationModel)}. Your choice stays saved; this host uses {textGenerationModelLabel(
            textGenerationSnapshot.effectiveTextGenerationModel,
          )}.
        </p>
      {/if}
    {/snippet}
  </SettingsRow>
</SettingsSection>

<SettingsAboutSection visible={isVisible("about")} />

{#if !anyVisible}
  <div
    class="py-8 text-center text-workspace-chrome text-(--solus-text-tertiary)"
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
