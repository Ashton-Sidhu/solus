<script lang="ts">
  import { Input } from "../ui/input";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import {
    BellIcon,
    MoonIcon,
    TextAaIcon,
    ClockCountdownIcon,
    GitBranchIcon,
    CheckIcon,
    CaretDownIcon,
    CodeIcon,
    NotePencilIcon,
    RobotIcon,
  } from "phosphor-svelte";
  import {
    APP_FONT_FAMILIES,
    APP_CODE_FONT_FAMILIES,
  } from "../../contexts/app/settings.context.svelte";
  import { getAgentContext, getSettingsContext, getWorkspaceContext } from "../../contexts";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { ChartBarIcon } from "phosphor-svelte";
  import { Switch } from "../ui/switch";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const session = getWorkspaceContext();

  const rateLimitStrats: [string, string][] = [
    ["ask", "Ask"],
    ["queue", "Queue"],
    ["stop", "Stop"],
    ["continue", "Continue"],
  ];

  const allAgentRows = $derived(buildAgentAvailabilityRows(agentContext.agents, agentContext.metadata));
  const agentRows = $derived(allAgentRows.filter((agent) => agent.enabled));
  const activeAgentLabel = $derived(agentLabel(theme.activeAgent, agentContext.metadata));

  let agentOpen = $state(false);
  let rateLimitOpen = $state(false);
  let agentTriggerEl: HTMLButtonElement | null = $state(null);
  let appFontTriggerEl: HTMLButtonElement | null = $state(null);
  let codeFontTriggerEl: HTMLButtonElement | null = $state(null);
  let rateLimitTriggerEl: HTMLButtonElement | null = $state(null);
  let appFontOpen = $state(false);
  let codeFontOpen = $state(false);

  // Models across all available agents, deduped by id — instructions are keyed
  // by resolved model id alone (matching statusBar.model), not per-agent.
  const modelRows = $derived(
    agentRows
      .flatMap((agent) => (agentContext.metadata[agent.id]?.models ?? []))
      .filter((model, i, all) => all.findIndex((o) => o.id === model.id) === i),
  );

  let modelInstructionsTriggerEl: HTMLButtonElement | null = $state(null);
  let modelInstructionsOpen = $state(false);
  let selectedModelId = $state(agentContext.metadata[theme.activeAgent]?.defaultModel ?? "");

  $effect(() => {
    if (!selectedModelId && modelRows.length > 0) selectedModelId = modelRows[0].id;
  });

  const selectedModelLabel = $derived(
    modelRows.find((m) => m.id === selectedModelId)?.label ?? selectedModelId,
  );

  function selectModelForInstructions(id: string) {
    selectedModelId = id;
    modelInstructionsOpen = false;
    requestInputFocus();
  }

  const appFontLabel = $derived(
    APP_FONT_FAMILIES.find((font) => font.id === theme.fontFamily)?.label ?? "System",
  );
  const codeFontLabel = $derived(
    APP_CODE_FONT_FAMILIES.find((font) => font.id === theme.codeFontFamily)?.label ?? "System",
  );
  const rateLimitLabel = $derived(
    theme.rateLimitBehavior.at(0)?.toUpperCase() + theme.rateLimitBehavior.slice(1),
  );

  function selectAgent(agentId: string) {
    session.switchActiveAgent(agentId);
    agentOpen = false;
    requestInputFocus();
  }

  function selectAppFont(value: typeof theme.fontFamily) {
    theme.update({ fontFamily: value });
    appFontOpen = false;
    requestInputFocus();
  }

  function selectCodeFont(value: typeof theme.codeFontFamily) {
    theme.update({ codeFontFamily: value });
    codeFontOpen = false;
    requestInputFocus();
  }

  function selectRateLimitBehavior(
    value: "ask" | "continue" | "stop" | "queue",
  ) {
    theme.update({ rateLimitBehavior: value });
    rateLimitOpen = false;
    requestInputFocus();
  }

  interface SettingItem {
    id: string;
    keywords: string[];
  }

  const settingItems: SettingItem[] = [
    { id: "theme", keywords: ["dark", "theme", "light", "appearance", "mode"] },
    { id: "agent", keywords: ["agent", "default", "claude", "ai", "model"] },
    { id: "notification", keywords: ["notification", "sound", "alert", "bell", "audio"] },
    { id: "font-family", keywords: ["font", "family", "typeface", "inter", "dm sans", "system", "geist", "lora", "serif"] },
    { id: "font-size", keywords: ["font", "size", "text", "zoom"] },
    { id: "code-font-family", keywords: ["code", "font", "mono", "monospace", "diff", "typeface", "sf mono", "geist", "fira", "jetbrains", "cascadia"] },
    { id: "code-font-size", keywords: ["code", "font", "size", "mono", "diff"] },
    { id: "ratelimit", keywords: ["rate", "limit", "behavior", "queue", "throttle"] },
    { id: "worktree", keywords: ["git", "worktree", "branch", "isolate", "session"] },
    { id: "analytics", keywords: ["analytics", "telemetry", "tracking", "privacy", "data"] },
    { id: "extra-instructions", keywords: ["extra", "instructions", "system", "prompt", "agent"] },
    { id: "model-instructions", keywords: ["model", "instructions", "system", "prompt", "per-model", "specific"] },
  ];

  function isVisible(id: string): boolean {
    if (!searchQuery) return true;
    const item = settingItems.find((s) => s.id === id);
    if (!item) return true;
    const q = searchQuery.toLowerCase();
    return item.keywords.some((k) => k.includes(q));
  }

  const anyVisible = $derived(settingItems.some((s) => isVisible(s.id)));

  const dropdownTriggerClass = "flex items-center justify-between gap-1.5 min-h-8 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-secondary) px-2.5 text-[0.8125rem] outline-none [transition:border-color_var(--duration-base)_var(--ease-premium),box-shadow_var(--duration-base)_var(--ease-premium),color_var(--duration-base)_var(--ease-premium)] hover:text-(--solus-text-primary) hover:border-(--solus-input-focus-border) focus-visible:text-(--solus-text-primary) focus-visible:border-(--solus-input-focus-border) focus-visible:shadow-[0_0_0_0.1875rem_var(--solus-input-focus-ring)]";
  // Markdown input styled to match the message composer: transparent field,
  // accent focus ring, and a forced 400 weight so typed text never reads bold.
  // The placeholder is absolutely positioned at left:0.25rem from the border,
  // so the wrapper's px-2.5 (0.625rem) must be added back to line it up with the
  // editor text (0.625rem wrapper pad + 0.25rem ProseMirror pad = 0.875rem).
  const mdFieldClass =
    "rounded-lg border border-(--solus-container-border) bg-transparent px-2.5 transition-colors focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)] [&_.solus-md-editor_.ProseMirror]:![min-height:4.5rem] [&_.solus-md-editor_.ProseMirror]:![font-weight:400] [&_.solus-md-placeholder]:![left:0.875rem]";
</script>

<div class="flex flex-col">
  {#if isVisible("theme")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <MoonIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Dark theme</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Switch between light and dark appearance</div>
        </div>
      </div>
      <Switch
        checked={theme.themeMode === "dark"}
        onCheckedChange={(next) =>
          theme.update({ themeMode: next ? "dark" : "light" })}
        size="default"
        aria-label="Toggle dark theme"
      />
    </div>
  {/if}

  {#if isVisible("agent")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <RobotIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Default agent</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">The AI agent used for new sessions</div>
        </div>
      </div>
      <div>
        <button
          bind:this={agentTriggerEl}
          type="button"
          aria-haspopup="menu"
          aria-expanded={agentOpen}
          onclick={() => { agentOpen = !agentOpen; appFontOpen = false; codeFontOpen = false; rateLimitOpen = false }}
          class={dropdownTriggerClass}
        >
          <span class="max-w-28 truncate">{activeAgentLabel}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <DropdownMenu.Root bind:open={agentOpen}>
          <DropdownMenu.Content customAnchor={agentTriggerEl} side="bottom" align="end" sideOffset={6} class="w-[160px]">
          <div class="py-1">
            {#each agentRows as agent (agent.id)}
              <DropdownMenu.Item class={agent.id === theme.activeAgent ? "font-semibold" : undefined} onSelect={() => selectAgent(agent.id)}>
                <span class="min-w-0 truncate">{agent.label}</span>
                {#if agent.id === theme.activeAgent}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownMenu.Item>
            {/each}
          </div>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  {/if}

  {#if isVisible("notification")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <BellIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Notification sound</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Play a sound when a task completes</div>
        </div>
      </div>
      <Switch
        checked={theme.soundEnabled}
        onCheckedChange={(next) => theme.update({ soundEnabled: next })}
        size="default"
        aria-label="Toggle notification sound"
      />
    </div>
  {/if}

  {#if isVisible("font-family")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <TextAaIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">App font</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Choose the interface typeface</div>
        </div>
      </div>
      <div>
        <button
          bind:this={appFontTriggerEl}
          type="button"
          aria-label="App font"
          aria-haspopup="menu"
          aria-expanded={appFontOpen}
          onclick={() => { appFontOpen = !appFontOpen }}
          class="{dropdownTriggerClass} min-w-24"
        >
          <span class="truncate">{appFontLabel}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <DropdownMenu.Root bind:open={appFontOpen}>
          <DropdownMenu.Content customAnchor={appFontTriggerEl} side="bottom" align="end" sideOffset={6} class="w-[176px]">
          <div class="py-1">
            {#each APP_FONT_FAMILIES as font (font.id)}
              <DropdownMenu.Item class={theme.fontFamily === font.id ? "font-semibold" : undefined} onSelect={() => selectAppFont(font.id)}>
                <span class="truncate">{font.label}</span>
                {#if theme.fontFamily === font.id}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownMenu.Item>
            {/each}
          </div>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  {/if}

  {#if isVisible("font-size")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <TextAaIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Font size</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Adjust the conversation text size</div>
        </div>
      </div>
      <div class="flex items-center rounded-lg border border-(--solus-container-border) overflow-hidden bg-(--solus-input-bg-soft)">
        <button
          type="button"
          onclick={() => theme.update({ fontSize: Math.max(8, theme.fontSize - 1) })}
          class="px-3 py-1.5 text-[0.8125rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover) transition-colors"
        >&minus;</button>
        <Input
          type="number"
          min={8}
          step={1}
          value={String(theme.fontSize)}
          onchange={(e) => {
            const v = Math.max(8, Number((e.target as HTMLInputElement).value));
            theme.update({ fontSize: v });
            (e.target as HTMLInputElement).value = String(v);
          }}
          class="h-auto w-12 rounded-none border-0 bg-transparent p-0 text-center text-[0.8125rem] shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="text-[0.6875rem] text-(--solus-text-tertiary) -ml-1 mr-1.5">px</span>
        <button
          type="button"
          onclick={() => theme.update({ fontSize: theme.fontSize + 1 })}
          class="px-3 py-1.5 text-[0.8125rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover) transition-colors"
        >+</button>
      </div>
    </div>
  {/if}

  {#if isVisible("code-font-family")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <CodeIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Code font</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Monospace font used in diffs</div>
        </div>
      </div>
      <div>
        <button
          bind:this={codeFontTriggerEl}
          type="button"
          aria-label="Code font"
          aria-haspopup="menu"
          aria-expanded={codeFontOpen}
          onclick={() => { codeFontOpen = !codeFontOpen }}
          class="{dropdownTriggerClass} min-w-24"
        >
          <span class="truncate">{codeFontLabel}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <DropdownMenu.Root bind:open={codeFontOpen}>
          <DropdownMenu.Content customAnchor={codeFontTriggerEl} side="bottom" align="end" sideOffset={6} class="w-[192px]">
          <div class="py-1">
            {#each APP_CODE_FONT_FAMILIES as font (font.id)}
              <DropdownMenu.Item class={theme.codeFontFamily === font.id ? "font-semibold" : undefined} onSelect={() => selectCodeFont(font.id)}>
                <span class="truncate">{font.label}</span>
                {#if theme.codeFontFamily === font.id}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownMenu.Item>
            {/each}
          </div>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  {/if}

  {#if isVisible("code-font-size")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <CodeIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Code font size</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Adjust the font size in diffs</div>
        </div>
      </div>
      <div class="flex items-center rounded-lg border border-(--solus-container-border) overflow-hidden bg-(--solus-input-bg-soft)">
        <button
          type="button"
          onclick={() => theme.update({ codeFontSize: Math.max(8, theme.codeFontSize - 1) })}
          class="px-3 py-1.5 text-[0.8125rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover) transition-colors"
        >&minus;</button>
        <Input
          type="number"
          min={8}
          step={1}
          value={String(theme.codeFontSize)}
          onchange={(e) => {
            const v = Math.max(8, Number((e.target as HTMLInputElement).value));
            theme.update({ codeFontSize: v });
            (e.target as HTMLInputElement).value = String(v);
          }}
          class="h-auto w-12 rounded-none border-0 bg-transparent p-0 text-center text-[0.8125rem] shadow-none focus-visible:ring-0 dark:bg-transparent [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span class="text-[0.6875rem] text-(--solus-text-tertiary) -ml-1 mr-1.5">px</span>
        <button
          type="button"
          onclick={() => theme.update({ codeFontSize: theme.codeFontSize + 1 })}
          class="px-3 py-1.5 text-[0.8125rem] text-(--solus-text-secondary) hover:text-(--solus-text-primary) hover:bg-(--solus-surface-hover) transition-colors"
        >+</button>
      </div>
    </div>
  {/if}

  {#if isVisible("ratelimit")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <ClockCountdownIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Rate limit behavior</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">What happens when a rate limit is hit</div>
        </div>
      </div>
      <div>
        <button
          bind:this={rateLimitTriggerEl}
          type="button"
          aria-haspopup="menu"
          aria-expanded={rateLimitOpen}
          onclick={() => { rateLimitOpen = !rateLimitOpen }}
          class={dropdownTriggerClass}
        >
          <span>{rateLimitLabel}</span>
          <CaretDownIcon size={11} style="opacity:0.6" />
        </button>
        <DropdownMenu.Root bind:open={rateLimitOpen}>
          <DropdownMenu.Content customAnchor={rateLimitTriggerEl} side="bottom" align="end" sideOffset={6} class="w-[144px]">
          <div class="py-1">
            {#each rateLimitStrats as [val, label] (val)}
              <DropdownMenu.Item
                class={theme.rateLimitBehavior === val ? "font-semibold" : undefined}
                onSelect={() => selectRateLimitBehavior(val as "ask" | "continue" | "stop" | "queue")}
              >
                {label}
                {#if theme.rateLimitBehavior === val}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownMenu.Item>
            {/each}
          </div>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>
  {/if}

  {#if isVisible("worktree")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <GitBranchIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Git worktrees for sessions</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Isolate each session in its own git worktree</div>
        </div>
      </div>
      <Switch
        checked={theme.worktreeEnabled}
        onCheckedChange={(next) => {
          theme.update({ worktreeEnabled: next });
          session.syncWorktreeDefault(next);
        }}
        size="default"
        aria-label="Toggle default worktree mode"
      />
    </div>
  {/if}

  {#if isVisible("analytics")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <ChartBarIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Share analytics</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Help improve Solus with anonymous usage data</div>
        </div>
      </div>
      <Switch
        checked={theme.analyticsEnabled}
        onCheckedChange={(next) => theme.update({ analyticsEnabled: next })}
        size="default"
        aria-label="Toggle analytics"
      />
    </div>
  {/if}

  {#if isVisible("extra-instructions")}
    <div class="flex flex-col gap-3 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <NotePencilIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Extra instructions</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Appended to the system prompt for every agent run</div>
        </div>
      </div>
      <MarkdownEditor
        value={theme.extraInstructions}
        onValueChange={(md) => theme.update({ extraInstructions: md })}
        onBlur={() => requestInputFocus()}
        enterInsertsNewline
        hidePlaceholderOnFocus
        maxHeight={220}
        placeholder="Prefer concise answers. Use specific libraries. Follow my writing style."
        class={mdFieldClass}
      />
    </div>
  {/if}

  {#if isVisible("model-instructions")}
    <div class="flex flex-col gap-3 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center justify-between gap-4">
        <div class="flex items-center gap-3 min-w-0">
          <NotePencilIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
          <div>
            <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Per-model instructions</div>
            <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Appended only when this model is running, on top of the extra instructions above</div>
          </div>
        </div>
        <div>
          <button
            bind:this={modelInstructionsTriggerEl}
            type="button"
            aria-label="Model"
            aria-haspopup="menu"
            aria-expanded={modelInstructionsOpen}
            disabled={modelRows.length === 0}
            onclick={() => { modelInstructionsOpen = !modelInstructionsOpen }}
            class="{dropdownTriggerClass} min-w-32 disabled:opacity-50"
          >
            <span class="truncate">{selectedModelLabel || "Select model"}</span>
            <CaretDownIcon size={11} style="opacity:0.6" />
          </button>
          <DropdownMenu.Root bind:open={modelInstructionsOpen}>
            <DropdownMenu.Content customAnchor={modelInstructionsTriggerEl} side="bottom" align="end" sideOffset={6} class="w-[220px]">
            <div class="py-1">
              {#each modelRows as model (model.id)}
                <DropdownMenu.Item class={model.id === selectedModelId ? "font-semibold" : undefined} onSelect={() => selectModelForInstructions(model.id)}>
                  <span class="flex items-center gap-1.5 min-w-0">
                    {#if theme.modelInstructions[model.id]?.trim()}
                      <span class="w-1.5 h-1.5 rounded-full bg-(--solus-accent) shrink-0"></span>
                    {/if}
                    <span class="truncate">{model.label}</span>
                  </span>
                  {#if model.id === selectedModelId}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
                </DropdownMenu.Item>
              {/each}
            </div>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      </div>
      <MarkdownEditor
        value={theme.modelInstructions[selectedModelId] ?? ""}
        onValueChange={(md) => theme.update({ modelInstructions: { ...theme.modelInstructions, [selectedModelId]: md } })}
        onBlur={() => requestInputFocus()}
        enterInsertsNewline
        hidePlaceholderOnFocus
        maxHeight={220}
        placeholder="Instructions that only apply when {selectedModelLabel || 'this model'} is running."
        class={mdFieldClass}
      />
    </div>
  {/if}

  {#if !anyVisible}
    <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      No settings match your search
    </div>
  {/if}
</div>
