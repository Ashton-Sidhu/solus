<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { FileTextIcon } from "phosphor-svelte";
  import CodeSpan from "../../ui/CodeSpan.svelte";
  import MarkdownLink from "../MarkdownLink.svelte";
  import MarkdownImage from "../MarkdownImage.svelte";
  import { markdownSanitizeUrl } from "../../../lib/markdownSanitize";
  import { assistantMarkdownOptions } from "../lib/assistant-markdown";
  import { replyArtefact, wordCount, type AgentMessage } from "./lib/agent-conversation";
  import AgentCodeBlock from "./AgentCodeBlock.svelte";
  import AgentTypingDots from "./AgentTypingDots.svelte";

  const markdownRenderers = {
    code: AgentCodeBlock,
    codespan: CodeSpan,
    image: MarkdownImage,
    link: MarkdownLink,
  };

  /**
   * One message: a label saying who said it, then the body. Both sides are
   * left-aligned in the same gutter — attribution is carried by the words, never
   * by alignment or a bubble, which is the renderer bug that caused most of the
   * confusion this component replaces.
   *
   * Size comes from the stream around it — both voices read at the same rung,
   * and only tone separates them: your prompts are muted, the agent's replies
   * are foreground, because the remote voice is the one being read.
   */
  interface Props {
    message: AgentMessage;
    agentName: string;
    /** Dots only render while the exchange is genuinely in flight; a settle that
     *  never arrived (app restart) must read as a quiet fact instead. */
    live: boolean;
    /** Height a completed reply is allowed before it folds behind "Show all".
     *  The switchboard clamps harder — its body is fixed. */
    clampPx?: number;
    /** Where an oversized artefact hands off to. */
    onOpen?: () => void;
    /** The top rule separates blocks; the first one in the body has nothing
     *  above it to separate from. */
    first?: boolean;
  }
  let { message, agentName, live, clampPx = 262, onOpen, first = false }: Props = $props();

  const label = $derived(
    message.from === "you"
      ? "You asked"
      : message.kind === "question"
        ? `${agentName} asked you`
        : `${agentName} replied`,
  );

  // A diff, a full file or a test log is an artefact rather than an answer: it
  // never inlines at any height.
  const artefact = $derived(message.kind === "reply" ? replyArtefact(message.text) : null);

  // Everything else in a settled card steps back; the reply steps back with it.
  // Defined in index.css beside the prose rules it settles — see the note there.
  const restTone = $derived(live ? "" : "prose-agent-card-rest");

  let expanded = $state(false);
  let bodyHeight = $state(0);
  const overflows = $derived(bodyHeight > clampPx);
  const clamped = $derived(!expanded && overflows);
</script>

<!-- The indicator occupies the reply slot of the newest block rather than
     opening one of its own: a "<Agent> replied" heading over three dots claims
     words nobody has said yet. So a pending slot carries no label and no rule —
     it reads as the tail of the message above it. -->
<div
  class={message.pending
    ? `pb-4 ${first ? "pt-3.5" : ""}`
    : `py-3.5 ${first ? "" : "border-t-[0.5px] border-(--solus-agent-card-rule)"}`}
>
  {#if !message.pending}
    <div
      class="text-transcript-meta mb-[7px] {message.from === 'you'
        ? 'font-medium text-muted-foreground'
        : 'font-medium text-[color-mix(in_oklch,var(--agent-accent)_74%,var(--foreground))]'}"
    >
      {label}
    </div>
  {/if}

  {#if message.pending}
    {#if live}
      <!-- Named rather than bare dots: the spec has the dots stand alone, but a
           reply slot with no label is the one place the card stops saying who
           is speaking, and the switchboard's tabs make that ambiguous. -->
      <span class="flex items-center gap-2">
        <span
          class="text-transcript-meta font-medium text-[color-mix(in_oklch,var(--agent-accent)_74%,var(--foreground))]"
        >
          {agentName} is responding
        </span>
        <AgentTypingDots variant="chip" />
      </span>
    {:else}
      <p class="m-0 text-muted-foreground/70">
        no reply recorded — open the session to catch up
      </p>
    {/if}
  {:else if artefact}
    {#if artefact.framing}
      <p class="m-0 mb-2.5 max-w-[600px] leading-[1.62] text-pretty {restTone}">
        {artefact.framing}
      </p>
    {/if}
    <div
      class="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_9%,transparent)]"
    >
      <FileTextIcon size={13} class="shrink-0 text-muted-foreground/60" />
      <span class="font-medium">{artefact.label}</span>
      <span class="flex-1"></span>
      {#if onOpen}
        <button
          class="shrink-0 rounded-md px-2 py-0.5 text-transcript-meta text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground"
          onclick={onOpen}
        >
          Open session
        </button>
      {/if}
    </div>
  {:else}
    <div class="relative overflow-hidden" style:max-height={clamped ? `${clampPx}px` : "none"}>
      {#if message.from === "you"}
        <p
          bind:clientHeight={bodyHeight}
          class="m-0 max-w-[580px] leading-[1.6] text-muted-foreground whitespace-pre-wrap text-pretty"
        >
          {message.text}
        </p>
      {:else}
        <div
          bind:clientHeight={bodyHeight}
          class="prose-cloud prose-reading prose-transcript prose-agent-card min-w-0 max-w-[600px] {restTone}"
        >
          {#if message.kind === "question"}
            {message.text}
          {:else}
            <SvelteMarkdown
              source={message.text}
              options={assistantMarkdownOptions}
              renderers={markdownRenderers}
              sanitizeUrl={markdownSanitizeUrl}
            />
          {/if}
        </div>
      {/if}
      {#if clamped}
        <div
          class="absolute inset-x-0 bottom-0 h-14 bg-[linear-gradient(to_bottom,transparent,var(--card)_72%)]"
        ></div>
      {/if}
    </div>
    {#if overflows}
      <button
        class="flex items-center gap-[7px] mt-2.5 text-transcript-meta text-muted-foreground cursor-pointer hover:text-foreground"
        onclick={() => (expanded = !expanded)}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="transition-transform {expanded ? 'rotate-180' : ''}"
        >
          <path d="M2.4 4.2L6 7.8l3.6-3.6" />
        </svg>
        <span>{expanded ? "Show less" : "Show all"}</span>
        <span class="opacity-65">· {wordCount(message.text)} words</span>
      </button>
    {/if}
  {/if}
</div>
