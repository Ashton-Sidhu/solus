<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { RobotIcon } from "phosphor-svelte";
  import type { Message } from "../../../shared/types";
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
  const workingDirectory = $derived(session.sessionFor(tabId)?.workingDirectory || undefined);

  let expanded = $state(false);

  // The Agent/Task tool input carries the sub-agent identity and its task.
  const parsedInput = $derived.by(() => {
    try {
      return JSON.parse(message.toolInput || "{}") as {
        subagent_type?: string;
        description?: string;
        prompt?: string;
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

  // The card rests on the tool result, not on the call's JSON finishing: a
  // sub-agent runs long after its input has streamed.
  const isRunning = $derived(message.toolResult === undefined);
  const isError = $derived(!!message.toolResultIsError);

  const subs = $derived(message.subMessages ?? []);
  const toolCount = $derived(subs.filter((m) => m.role === "tool").length);
  const filesTouched = $derived.by(() => {
    const files = new Set<string>();
    for (const m of subs) {
      if (m.role !== "tool") continue;
      if (m.toolName !== "Write" && m.toolName !== "Edit") continue;
      try {
        const fp = (JSON.parse(m.toolInput || "{}") as { file_path?: string }).file_path;
        if (fp) files.add(fp);
      } catch {}
    }
    return files.size;
  });

  /** Short label for a sub-tool, used by the running ticker. */
  function toolLabel(m: Message): string {
    const name = m.toolName || "Tool";
    if (solusToolKey(name)) return prettyToolName(name);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(m.toolInput || "{}");
    } catch {}
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
    <span class="flex min-w-0 flex-col gap-1">
      <span class="flex min-w-0 items-center gap-2">
        <span
          class="shrink-0 rounded-md bg-(--solus-accent-soft) px-1.5 py-px text-[0.625rem] font-medium text-(--solus-accent)"
          >{subagentType}</span
        >
        {#if isRunning}
          <span class="min-w-0 truncate text-xs text-(--solus-text-tertiary)">{ticker}</span>
        {:else}
          <span
            class="min-w-0 truncate text-xs"
            style:color={isError ? "var(--solus-art-negative)" : "var(--solus-art-positive)"}
            >{isError ? "Failed" : resultSummary}</span
          >
        {/if}
        {#if countLabel}
          <span class="shrink-0 text-[0.625rem] text-(--solus-text-tertiary)">{countLabel}</span>
        {/if}
      </span>
      {#if isRunning}
        <span class="subagent-bar" aria-hidden="true"></span>
      {/if}
    </span>
  {/snippet}

  <div class="space-y-2 px-3 py-2.5">
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
    {#if message.subStreamText}
      <div class="prose-cloud prose-reading min-w-0 text-sm">
        <SvelteMarkdown
          source={message.subStreamText}
          streaming
          renderers={markdownRenderers}
          sanitizeUrl={markdownSanitizeUrl}
        />
      </div>
    {/if}
    {#if grouped.length === 0 && !message.subStreamText}
      <span class="text-xs text-(--solus-text-tertiary)">Starting up…</span>
    {/if}
  </div>
</ConversationRefCard>

<style>
  /* Indeterminate progress sliver — the sub-agent runs for an unknown duration,
     so we show motion rather than a fraction. */
  .subagent-bar {
    position: relative;
    display: block;
    height: 0.125rem;
    width: 100%;
    overflow: hidden;
    border-radius: 9999px;
    background: var(--solus-accent-soft);
  }
  .subagent-bar::after {
    content: "";
    position: absolute;
    inset: 0;
    width: 40%;
    border-radius: 9999px;
    background: var(--solus-accent);
    animation: subagent-indeterminate 1.2s ease-in-out infinite;
  }
  @keyframes subagent-indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(250%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .subagent-bar::after {
      animation: none;
    }
  }
</style>
