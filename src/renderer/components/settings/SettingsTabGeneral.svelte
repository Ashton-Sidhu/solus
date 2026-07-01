<script lang="ts">
  import Input from "../ui/Input.svelte";
  import MarkdownEditor from "../MarkdownEditor.svelte";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import {
    BellIcon,
    MoonIcon,
    SidebarIcon,
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
    getSettingsContext,
  } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getWindowContext } from "../../contexts/window.context.svelte";
  import { agentLabel, buildAgentAvailabilityRows } from "../../lib/agentAvailability";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { ChartBarIcon } from "phosphor-svelte";

  interface Props {
    searchQuery?: string;
  }

  let { searchQuery = "" }: Props = $props();

  const theme = getSettingsContext();
  const agentContext = getAgentContext();
  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();

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
    { id: "editor-mode", keywords: ["editor", "mode", "layout", "fullscreen", "full-screen", "sidebar"] },
    { id: "notification", keywords: ["notification", "sound", "alert", "bell", "audio"] },
    { id: "font-family", keywords: ["font", "family", "typeface", "inter", "dm sans", "system", "geist", "lora", "serif"] },
    { id: "font-size", keywords: ["font", "size", "text", "zoom"] },
    { id: "code-font-family", keywords: ["code", "font", "mono", "monospace", "diff", "typeface", "sf mono", "geist", "fira", "jetbrains", "cascadia"] },
    { id: "code-font-size", keywords: ["code", "font", "size", "mono", "diff"] },
    { id: "ratelimit", keywords: ["rate", "limit", "behavior", "queue", "throttle"] },
    { id: "worktree", keywords: ["git", "worktree", "branch", "isolate", "session"] },
    { id: "analytics", keywords: ["analytics", "telemetry", "tracking", "privacy", "data"] },
    { id: "extra-instructions", keywords: ["extra", "instructions", "system", "prompt", "agent"] },
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
      {@render toggle(
        theme.themeMode === "dark",
        (next) => theme.update({ themeMode: next ? "dark" : "light" }),
        "Toggle dark theme",
      )}
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
        <Dropdown bind:open={agentOpen} triggerEl={agentTriggerEl} align="top" anchor="right" width={160}>
          <div class="py-1">
            {#each agentRows as agent (agent.id)}
              <DropdownItem selected={agent.id === theme.activeAgent} onclick={() => selectAgent(agent.id)}>
                <span class="min-w-0 truncate">{agent.label}</span>
                {#if agent.id === theme.activeAgent}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
      </div>
    </div>
  {/if}

  {#if isVisible("editor-mode")}
    <div class="flex items-center justify-between gap-4 py-3.5 border-b border-b-(--solus-container-border)/50 last:border-b-0">
      <div class="flex items-center gap-3 min-w-0">
        <SidebarIcon size={16} class="shrink-0 text-(--solus-text-tertiary)" />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">Editor mode</div>
          <div class="text-[clamp(0.6875rem,0.64rem+0.2vw,0.8125rem)] text-(--solus-text-tertiary) mt-px">Full-screen editor layout (⌥⇧E)</div>
        </div>
      </div>
      {@render toggle(
        windowCtx.viewMode === "editor",
        () => session.toggleViewMode(),
        "Toggle editor mode",
      )}
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
      {@render toggle(
        theme.soundEnabled,
        (next) => theme.update({ soundEnabled: next }),
        "Toggle notification sound",
      )}
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
        <Dropdown bind:open={appFontOpen} triggerEl={appFontTriggerEl} align="top" anchor="right" width={176}>
          <div class="py-1">
            {#each APP_FONT_FAMILIES as font (font.id)}
              <DropdownItem selected={theme.fontFamily === font.id} onclick={() => selectAppFont(font.id)}>
                <span class="truncate">{font.label}</span>
                {#if theme.fontFamily === font.id}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
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
          variant="bare"
          size="sm"
          min={8}
          step={1}
          value={String(theme.fontSize)}
          onchange={(e) => {
            const v = Math.max(8, Number((e.target as HTMLInputElement).value));
            theme.update({ fontSize: v });
            (e.target as HTMLInputElement).value = String(v);
          }}
          class="w-12 text-[0.8125rem]"
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
        <Dropdown bind:open={codeFontOpen} triggerEl={codeFontTriggerEl} align="top" anchor="right" width={192}>
          <div class="py-1">
            {#each APP_CODE_FONT_FAMILIES as font (font.id)}
              <DropdownItem selected={theme.codeFontFamily === font.id} onclick={() => selectCodeFont(font.id)}>
                <span class="truncate">{font.label}</span>
                {#if theme.codeFontFamily === font.id}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
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
          variant="bare"
          size="sm"
          min={8}
          step={1}
          value={String(theme.codeFontSize)}
          onchange={(e) => {
            const v = Math.max(8, Number((e.target as HTMLInputElement).value));
            theme.update({ codeFontSize: v });
            (e.target as HTMLInputElement).value = String(v);
          }}
          class="w-12 text-[0.8125rem]"
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
        <Dropdown bind:open={rateLimitOpen} triggerEl={rateLimitTriggerEl} align="top" anchor="right" width={144}>
          <div class="py-1">
            {#each rateLimitStrats as [val, label] (val)}
              <DropdownItem
                selected={theme.rateLimitBehavior === val}
                onclick={() => selectRateLimitBehavior(val as "ask" | "continue" | "stop" | "queue")}
              >
                {label}
                {#if theme.rateLimitBehavior === val}<CheckIcon size={14} class="text-(--solus-accent)" />{/if}
              </DropdownItem>
            {/each}
          </div>
        </Dropdown>
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
      {@render toggle(
        theme.worktreeEnabled,
        (next) => {
          theme.update({ worktreeEnabled: next });
          session.syncWorktreeDefault(next);
        },
        "Toggle default worktree mode",
      )}
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
      {@render toggle(
        theme.analyticsEnabled,
        (next) => theme.update({ analyticsEnabled: next }),
        "Toggle analytics",
      )}
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

  {#if !anyVisible}
    <div class="py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      No settings match your search
    </div>
  {/if}
</div>

{#snippet toggle(checked: boolean, onChange: (next: boolean) => void, label: string)}
  <button
    type="button"
    aria-label={label}
    aria-pressed={checked}
    onclick={() => onChange(!checked)}
    class="relative w-[2.375rem] h-[1.375rem] rounded-[0.6875rem] border cursor-pointer shrink-0 [transition:background_0.2s_ease,border-color_0.2s_ease]
      {checked ? 'bg-(--solus-accent) border-(--solus-accent)' : 'bg-(--solus-surface-secondary) border-(--solus-container-border)'}"
  >
    <span class="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-lg bg-white [transition:left_0.2s_ease] shadow-[0_1px_3px_rgba(0,0,0,0.1)]" style="left:{checked ? 20 : 3}px"></span>
  </button>
{/snippet}
