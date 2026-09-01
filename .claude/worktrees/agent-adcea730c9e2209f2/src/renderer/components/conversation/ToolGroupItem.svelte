<script lang="ts">
  import {
    FileTextIcon,
    PencilSimpleIcon,
    FileArrowUpIcon,
    TerminalIcon,
    MagnifyingGlassIcon,
    GlobeIcon,
    RobotIcon,
    QuestionIcon,
    WrenchIcon,
    FolderOpenIcon,
    CaretRightIcon,
    CaretDownIcon,
  } from "phosphor-svelte";
  import type { Component } from "svelte";
  import { runtime } from "../../contexts/runtime.svelte";
  import { prettyToolName, solusToolKey } from "../../contexts/session.utils";
  import type { Message } from "../../../shared/types";

  interface Props {
    tools: Message[];
    skipMotion?: boolean;
  }
  let { tools, skipMotion = false }: Props = $props();

  let expanded = $state(false);

  const TOOL_ICONS: Record<string, Component> = {
    Read: FileTextIcon,
    Edit: PencilSimpleIcon,
    Write: FileArrowUpIcon,
    Bash: TerminalIcon,
    Glob: FolderOpenIcon,
    Grep: MagnifyingGlassIcon,
    WebSearch: GlobeIcon,
    WebFetch: GlobeIcon,
    Agent: RobotIcon,
    AskUserQuestion: QuestionIcon,
  };

  const hasRunning = $derived(tools.some((t) => t.toolStatus === "running"));
  const isOpen = $derived(expanded || hasRunning);

  const parseCache = new WeakMap<Message, Record<string, unknown> | null>();

  // A running tool's toolInput is empty/absent — the full input lands only at
  // completion. Parsing (and caching) it while running would pin a stale null, so
  // skip until it's done, then parse each tool at most once, cached on the message.
  const parsedInputs = $derived(
    tools.map((tool) => {
      if (!tool.toolInput || tool.toolStatus === "running") return null;
      const cached = parseCache.get(tool);
      if (cached !== undefined) return cached;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(tool.toolInput) as Record<string, unknown>;
      } catch {}
      parseCache.set(tool, parsed);
      return parsed;
    }),
  );

  const CHANGE_PATH_KEYS = [
    "file_path",
    "filePath",
    "path",
    "file",
    "fileName",
    "filename",
    "old_path",
    "new_path",
    "oldPath",
    "newPath",
  ];

  function addToolPath(paths: Set<string>, value: unknown): void {
    if (typeof value !== "string") return;
    let path = value.trim();
    if (!path || path === "/dev/null") return;
    if (
      (path.startsWith('"') && path.endsWith('"')) ||
      (path.startsWith("'") && path.endsWith("'"))
    ) {
      path = path.slice(1, -1);
    }
    paths.add(path);
  }

  function toolPathsFromParsed(parsed: Record<string, unknown>): string[] {
    const paths = new Set<string>();
    for (const key of CHANGE_PATH_KEYS) addToolPath(paths, parsed[key]);

    const changes = parsed.changes;
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (!change || typeof change !== "object") continue;
        const record = change as Record<string, unknown>;
        for (const key of CHANGE_PATH_KEYS) addToolPath(paths, record[key]);
      }
    }

    return [...paths];
  }

  function describeFilePaths(action: string, paths: string[]): string {
    if (paths.length === 0) return `${action} file`;
    if (paths.length === 1) return `${action} ${paths[0]}`;
    return `${action} ${paths[0]} and ${paths.length - 1} more file${paths.length > 2 ? "s" : ""}`;
  }

  function getToolDescriptionFromParsed(
    name: string,
    parsed: Record<string, unknown>,
    options: { truncate?: boolean } = {},
  ): string {
    const truncate = options.truncate ?? true;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    // Solus tools show just their friendly label — no args.
    if (solusToolKey(name)) return prettyToolName(name);
    switch (name) {
      case "Read":
        return `Read ${s(parsed.file_path) || s(parsed.path) || "file"}`;
      case "Edit":
        return describeFilePaths("Edit", toolPathsFromParsed(parsed));
      case "Write":
        return describeFilePaths("Write", toolPathsFromParsed(parsed));
      case "Glob":
        return `Search files: ${s(parsed.pattern)}`;
      case "Grep":
        return `Search: ${s(parsed.pattern)}`;
      case "Bash": {
        const cmd = s(parsed.command);
        return truncate && cmd.length > 60
          ? `${cmd.substring(0, 57)}...`
          : cmd || "Bash";
      }
      case "WebSearch":
        return `Search: ${s(parsed.query) || s(parsed.search_query)}`;
      case "WebFetch":
        return `Fetch: ${s(parsed.url)}`;
      case "Agent":
        return `Agent: ${truncate ? (s(parsed.prompt) || s(parsed.description)).substring(0, 100) : s(parsed.prompt) || s(parsed.description)}`;
      case "Skill":
        return s(parsed.skill) ? `Skill: ${s(parsed.skill)}` : "Skill";
      default:
        return name;
    }
  }

  function getToolDescription(
    name: string,
    input?: string,
    options: { truncate?: boolean } = {},
  ): string {
    const pretty = prettyToolName(name);
    const truncate = options.truncate ?? true;
    // Solus tools show just their friendly label — never their args.
    if (solusToolKey(name)) return pretty;
    if (!input) return pretty;
    try {
      const parsed = JSON.parse(input);
      return getToolDescriptionFromParsed(name, parsed, { truncate });
    } catch {
      const trimmed = input.trim();
      if (truncate && trimmed.length > 60)
        return `${pretty}: ${trimmed.substring(0, 57)}...`;
      return trimmed ? `${pretty}: ${trimmed}` : pretty;
    }
  }

  function toolSummary(): string {
    if (tools.length === 0) return "";
    const first = tools[0];
    const desc = getToolDescription(first.toolName || "Tool", first.toolInput);
    if (tools.length === 1) return desc;
    return `${desc} and ${tools.length - 1} more tool${tools.length > 2 ? "s" : ""}`;
  }
</script>

{#if isOpen}
  <div class="py-1 {skipMotion ? '' : 'animate-msg-in-side'}">
    {#if !hasRunning}
      <div
        class="flex items-center gap-1 cursor-pointer mb-1.5 border-t border-(--solus-message-divider) rounded-md transition-colors hover:text-(--solus-text-secondary) active:bg-(--solus-surface-hover) focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) {runtime.isMobileViewport
          ? 'py-1'
          : ''}"
        onclick={() => (expanded = false)}
        style="padding-top:0.375rem"
        role="button"
        tabindex="0"
        onkeydown={(e) => {
          if (e.key === "Enter") expanded = false;
        }}
      >
        <CaretDownIcon size={10} class="text-(--solus-text-tertiary)" />
        <span class="text-[0.6875rem] text-(--solus-text-tertiary)">
          Used {tools.length} tool{tools.length !== 1 ? "s" : ""}
        </span>
      </div>
    {/if}

    <div class="relative pl-6">
      <div
        class="absolute left-[0.625rem] top-1 bottom-1 w-[0.0938rem] bg-(--solus-assistant-left-border)"
      ></div>
      <div class="space-y-2.5">
        {#each tools as tool, i (tool.id)}
          {@const isRunning = tool.toolStatus === "running"}
          {@const toolName = tool.toolName || "Tool"}
          {@const parsedInput = parsedInputs[i]}
          {@const fullDesc = isRunning
            ? toolName === "exec_command"
              ? getToolDescription(toolName, tool.toolInput, {
                  truncate: false,
                })
              : prettyToolName(toolName)
            : parsedInput
              ? getToolDescriptionFromParsed(toolName, parsedInput, {
                  truncate: false,
                })
              : getToolDescription(toolName, tool.toolInput, {
                  truncate: false,
                })}
          {@const filePaths = parsedInput
            ? toolPathsFromParsed(parsedInput)
            : []}
          {@const ToolIcon =
            TOOL_ICONS[toolName] ||
            (solusToolKey(toolName) ? FileTextIcon : WrenchIcon)}
          <div class="group/tool relative">
            <div
              class="absolute -left-6 top-px w-5 h-5 rounded-full flex items-center justify-center"
              style="background:{isRunning
                ? 'var(--solus-tool-running-bg)'
                : 'var(--solus-timeline-node-done)'};border:0.0625rem solid {isRunning
                ? 'var(--solus-tool-running-border)'
                : 'var(--solus-timeline-node-done)'}"
            >
              {#if isRunning}
                <span
                  class="w-1.5 h-1.5 rounded-full animate-pulse-dot bg-(--solus-status-running)"
                ></span>
              {:else}
                <span class="flex items-center text-(--solus-text-tertiary)">
                  <ToolIcon size={10} />
                </span>
              {/if}
            </div>

            <div class="min-w-0">
              <div class="flex items-center gap-3 min-w-0">
                <span
                  class="text-[0.75rem] leading-[1.4] min-w-0 truncate group-hover/tool:whitespace-normal group-hover/tool:break-words"
                  class:text-(--solus-text-secondary)={isRunning}
                  class:text-(--solus-text-tertiary)={!isRunning}
                  >{fullDesc}</span
                >
              </div>

              {#if isRunning}
                <span
                  class="text-[0.625rem] mt-0.5 block text-(--solus-text-tertiary)"
                  >in progress</span
                >
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{:else}
  <div
    class="flex items-start gap-1 cursor-pointer rounded-md px-1 transition-colors hover:bg-(--solus-surface-hover) active:bg-(--solus-surface-hover) focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium) {runtime.isMobileViewport
      ? 'py-1.5'
      : 'py-[0.25rem]'} {skipMotion ? '' : 'animate-msg-in-side'}"
    onclick={() => (expanded = true)}
    role="button"
    tabindex="0"
    onkeydown={(e) => {
      if (e.key === "Enter") expanded = true;
    }}
  >
    <CaretRightIcon
      size={10}
      class="flex-shrink-0 mt-[0.125rem] text-(--solus-text-tertiary)"
    />
    <span class="text-[0.75rem] leading-[1.4] text-(--solus-text-secondary)"
      >{toolSummary()}</span
    >
  </div>
{/if}
