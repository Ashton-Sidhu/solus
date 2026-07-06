<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { RobotIcon } from "phosphor-svelte";
  import { REASONING_EFFORT_LABELS, type Message, type ReasoningEffort } from "../../../shared/types";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { prettyToolName, solusToolKey } from "../../contexts/session.utils";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import ConversationRefCard from "./ConversationRefCard.svelte";
  import ToolGroupItem from "./ToolGroupItem.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import MarkdownLink from "./MarkdownLink.svelte";

  interface Props {
    message: Message;
    tabId: string;
    skipMotion?: boolean;
  }
  let { message, tabId, skipMotion = false }: Props = $props();

  const markdownRenderers = { code: CodeBlock, codespan: CodeSpan, link: MarkdownLink };
  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));
  const workingDirectory = $derived(sess?.workingDirectory || undefined);

  let expanded = $state(false);

  // The Agent/Task tool input carries the sub-agent identity and its task.
  const parsedInput = $derived.by(() => {
    try {
      return JSON.parse(message.toolInput || "{}") as {
        subagent_type?: string;
        description?: string;
        prompt?: string;
        model?: string;
        reasoning_effort?: string;
      };
    } catch {
      return {};
    }
  });
  const subagentType = $derived(
    message.subagentType || parsedInput.subagent_type || "agent",
  );
  const task = $derived(
    (parsedInput.description || parsedInput.prompt || "Sub-agent").trim(),
  );
  const modelLabel = $derived(
    (parsedInput.model || sess?.sessionModel || sess?.modelConfig.modelId || "").trim(),
  );
  const reasoningEffort = $derived(
    (parsedInput.reasoning_effort || sess?.modelConfig.reasoningEffort || "").trim(),
  );
  const reasoningLabel = $derived(
    REASONING_EFFORT_LABELS[reasoningEffort as ReasoningEffort] ?? reasoningEffort,
  );

  // The card rests on the tool result, not on the call's JSON finishing: a
  // sub-agent runs long after its input has streamed.
  const isRunning = $derived(message.toolResult === undefined);
  const isError = $derived(!!message.toolResultIsError);

  const subs = $derived(message.subMessages ?? []);
  const toolCount = $derived(subs.filter((m) => m.role === "tool").length);

  // A sub-tool's toolInput carries whole file bodies (Write/Edit) and can still
  // change while running (Codex patch updates replace it). Parse each sub message
  // at most once, cached on the message object, and never while it's running —
  // the cache would otherwise pin a stale parse. So a sub-agent event costs
  // O(new message), not O(all sub-messages).
  const subParseCache = new WeakMap<Message, Record<string, unknown> | null>();
  function parseSubInput(m: Message): Record<string, unknown> | null {
    if (!m.toolInput || m.toolStatus === "running") return null;
    const cached = subParseCache.get(m);
    if (cached !== undefined) return cached;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(m.toolInput) as Record<string, unknown>;
    } catch {}
    subParseCache.set(m, parsed);
    return parsed;
  }

  const filesTouched = $derived.by(() => {
    const files = new Set<string>();
    for (const m of subs) {
      if (m.role !== "tool") continue;
      if (m.toolName !== "Write" && m.toolName !== "Edit") continue;
      const fp = parseSubInput(m)?.file_path;
      if (typeof fp === "string" && fp) files.add(fp);
    }
    return files.size;
  });

  /** Short label for a sub-tool, used by the running ticker. */
  function toolLabel(m: Message): string {
    const name = m.toolName || "Tool";
    if (solusToolKey(name)) return prettyToolName(name);
    // Running / unparseable: cheap fallback, never parse the growing partial JSON.
    const parsed = parseSubInput(m);
    if (!parsed) return prettyToolName(name);
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const arg =
      s(parsed.file_path) ||
      s(parsed.path) ||
      s(parsed.pattern) ||
      s(parsed.query) ||
      s(parsed.command);
    return arg ? `${prettyToolName(name)} ${arg}` : prettyToolName(name);
  }

  // Latest activity drives the running ticker.
  const ticker = $derived.by(() => {
    for (let i = subs.length - 1; i >= 0; i--) {
      if (subs[i].role === "tool") return toolLabel(subs[i]);
    }
    return "Working…";
  });

  // First non-empty line of the sub-agent's final answer.
  const resultSummary = $derived.by(() => {
    const first = (message.toolResult ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!first) return "Done";
    return first.length > 140 ? `${first.slice(0, 137)}…` : first;
  });

  // Nested transcript: consecutive tool messages group into one ToolGroupItem;
  // assistant text renders as markdown — mirroring the main thread.
  type SubItem =
    | { kind: "tool-group"; messages: Message[] }
    | { kind: "assistant"; message: Message };

  const grouped = $derived.by(() => {
    const result: SubItem[] = [];
    let buf: Message[] = [];
    const flush = () => {
      if (buf.length > 0) {
        result.push({ kind: "tool-group", messages: buf });
        buf = [];
      }
    };
    for (const m of subs) {
      if (m.role === "tool") buf.push(m);
      else if (m.role === "assistant" && m.content.trim()) {
        flush();
        result.push({ kind: "assistant", message: m });
      }
    }
    flush();
    return result;
  });

  const countLabel = $derived(
    [
      toolCount > 0 ? `${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : "",
      filesTouched > 0 ? `${filesTouched} ${filesTouched === 1 ? "file" : "files"}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );

</script>

<ConversationRefCard
  title={task}
  ariaLabel={`Sub-agent: ${subagentType}`}
  data-testid="subagent-card"
  expandable
  {expanded}
  {skipMotion}
  onOpen={() => (expanded = !expanded)}
>
  {#snippet icon()}
    <span style:color="var(--solus-accent)">
      <RobotIcon size={18} weight="regular" />
    </span>
  {/snippet}

  {#snippet statusSlot()}
    <span class="flex min-w-0 flex-col gap-1.5">
      <span class="flex min-w-0 items-baseline gap-2">
        <span class="shrink-0 text-[0.6875rem] font-[560] text-(--solus-accent)">{subagentType}</span>
        {#if isRunning}
          <span class="min-w-0 truncate text-xs leading-snug text-(--solus-text-tertiary)">{ticker}</span>
        {:else}
          <span
            class="min-w-0 truncate text-xs leading-snug"
            style:color={isError ? "var(--solus-art-negative)" : "var(--solus-art-positive)"}
            >{isError ? "Failed" : resultSummary}</span
          >
        {/if}
      </span>
      {#if modelLabel || reasoningLabel}
        <span class="flex min-w-0 flex-wrap items-center gap-1">
          {#if modelLabel}
            <span
              class="inline-flex items-center rounded-md bg-(--solus-accent-light) px-1.5 py-0.5 text-[0.625rem] font-medium text-(--solus-text-secondary)"
              >{modelLabel}</span
            >
          {/if}
          {#if reasoningLabel}
            <span
              class="inline-flex items-center rounded-md bg-(--solus-surface-hover) px-1.5 py-0.5 text-[0.625rem] font-medium text-(--solus-text-tertiary)"
              >{reasoningLabel}</span
            >
          {/if}
        </span>
      {/if}
      {#if isRunning}
        <span
          class="relative block h-0.5 w-full overflow-hidden rounded-full bg-(--solus-accent-soft)"
          aria-hidden="true"
        >
          <span
            class="absolute inset-y-0 left-0 w-2/5 rounded-full bg-(--solus-accent) animate-[subagent-indeterminate_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
          ></span>
        </span>
      {/if}
    </span>
  {/snippet}

  <div class="flex flex-col gap-2 px-4 pt-3 pb-3.5">
    {#if countLabel}
      <div class="text-[0.6875rem] leading-snug text-(--solus-text-tertiary) tabular-nums">{countLabel}</div>
    {/if}
    {#each grouped as item (item.kind === "tool-group" ? `tg-${item.messages[0].id}` : item.message.id)}
      {#if item.kind === "tool-group"}
        <ToolGroupItem tools={item.messages} {tabId} {workingDirectory} skipMotion />
      {:else}
        <div class="prose-cloud prose-reading min-w-0 text-sm">
          <SvelteMarkdown
            source={item.message.content.trim()}
            renderers={markdownRenderers}
            sanitizeUrl={markdownSanitizeUrl}
          />
        </div>
      {/if}
    {/each}
    {#if grouped.length === 0}
      <span class="text-xs text-(--solus-text-tertiary)">Starting up…</span>
    {/if}
  </div>
</ConversationRefCard>
