<script lang="ts">
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import { ChevronDown as CaretDownIcon, User as UserIcon } from "@lucide/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { markdownSanitizeUrl } from "../../lib/markdownSanitize";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import CodeBlock from "../ui/CodeBlock.svelte";
  import CodeSpan from "../ui/CodeSpan.svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import {
    exchangeMeta,
    transcriptAsText,
    transcriptIsEmpty,
    type TranscriptPane,
    type TranscriptRole,
  } from "./lib/turn-transcript";

  /**
   * The turn's own words: what it was asked, what it answered, and the
   * instructions it ran under.
   *
   * The card used to draw the three as interchangeable disclosure rows — same
   * height, same ink, same caret, two of them open onto long text — so the
   * reader met a stack of prose with nothing telling them where the ask ended
   * and the answer began. Nothing was missing; the shape carried no meaning.
   *
   * It reads as the conversation it records, in the transcript's own grammar:
   * the ask is a bubble on a 2% fill, held to the right and to a message's
   * width; the answer is prose on the ground, left, at the width and reading
   * size a reply gets. Those two shapes are what the reader already knows a
   * person's words and an agent's words to look like, so the roles need no
   * rail, no colour key, and no status mark to be told apart. Above each side
   * is a caption, not a heading: the two speakers by name — the user, then the
   * backend that answered, beside its own logo — because a page that compares
   * Claude Code against Codex should say which one is talking here.
   *
   * Neither side is behind a control, since a turn's exchange is the reason
   * this card is open.
   *
   * The instructions are the largest text a turn carries and the one a reader
   * opens deliberately, so they sit under the card's own hairline as a footer
   * disclosure and stay closed until asked for.
   *
   * A recorded answer can still be tens of thousands of characters, so every
   * text opens at a bounded height, fades at the cut, and expands on demand.
   * The header states what was stored when the capture capped it, because a
   * silently clipped answer reads as a short one.
   */
  interface Props {
    panes: TranscriptPane[];
  }

  let { panes }: Props = $props();

  // Fences get the app's code block — the transcript is a reading surface, so a
  // recorded answer keeps its highlighting and its own copy control.
  const markdownRenderers = { code: CodeBlock, codespan: CodeSpan };

  const ask = $derived(panes.find((pane) => pane.role === "prompt") ?? null);
  const answer = $derived(panes.find((pane) => pane.role === "response") ?? null);
  const instructions = $derived(panes.find((pane) => pane.role === "system") ?? null);
  const empty = $derived(transcriptIsEmpty(panes));
  const meta = $derived(exchangeMeta(panes));

  // Held across turns: a reader who opened the instructions is reading
  // instructions, and re-closing them on every step through the list is the
  // wrong default.
  let instructionsOpen = $state(false);
  const expandedRoles = new SvelteSet<TranscriptRole>();

  function toggleExpanded(role: TranscriptRole): void {
    if (expandedRoles.has(role)) expandedRoles.delete(role);
    else expandedRoles.add(role);
  }

  // Whether the bound height actually cuts this text. A prompt of two lines is
  // the common case, and offering it a fade and a "Show more" states a cut that
  // never happened — the reader then looks for text that is all on screen.
  // Measured rather than guessed from length, because the cut depends on the
  // panel's width and on the reader's text-size preference.
  const cutRoles = new SvelteSet<TranscriptRole>();

  function probeCut(node: HTMLElement, role: TranscriptRole) {
    const measure = () => {
      // An expanded text is measured against the tall bound, so one that fits
      // there would clear the flag and take the "Show less" control away from
      // the reader who is using it. The collapsed reading answers the question.
      if (expandedRoles.has(role)) return;
      if (node.scrollHeight > node.clientHeight + 1) cutRoles.add(role);
      else cutRoles.delete(role);
    };
    // The scroller reports the cut, its content reports the growth: a text that
    // reflows changes the child's height while the scroller keeps its own.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return { destroy: () => observer.disconnect() };
  }
</script>

<!-- One text, bounded and expandable. `collapsed` is the role's own resting
     height: an ask is held to a few lines, an answer is given the room a reply
     needs. `alignEnd` keeps the expand control on the side its words are on. -->
{#snippet body(pane: TranscriptPane, collapsed: string, alignEnd = false)}
  {@const expanded = expandedRoles.has(pane.role)}
  {@const cut = cutRoles.has(pane.role)}
  <!-- Collapsed is clipped and masked rather than scrolled: a pane with its own
       scrollbar inside a scrolling panel steals the wheel. Expanded scrolls,
       bounded, under the standard thumb. -->
  <div
    class="{expanded
      ? 'scrollbar-on-hover max-h-[42rem] overflow-y-auto overscroll-contain pr-2'
      : `${collapsed} overflow-hidden`} {cut && !expanded ? 'transcript-cut' : ''}"
    use:probeCut={pane.role}
  >
    {#if pane.role === "prompt"}
      <!-- The ask is typed text, not markdown: it is set as it was sent, with
           its own line breaks kept. -->
      <p class="transcript-text m-0 whitespace-pre-wrap text-pretty select-text">
        {pane.text}
      </p>
    {:else}
      <div
        class="transcript-text prose-cloud prose-reading prose-transcript min-w-0 {pane.role ===
        'system'
          ? 'text-muted-foreground'
          : ''}"
      >
        <SvelteMarkdown
          source={pane.text}
          renderers={markdownRenderers}
          sanitizeUrl={markdownSanitizeUrl}
        />
      </div>
    {/if}
  </div>

  {#if cut || expanded}
    <button
      type="button"
      class="mt-1.5 flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-xs text-muted-foreground transition-colors select-none hover:bg-[var(--wash-1)] hover:text-foreground {alignEnd
        ? 'ml-auto'
        : ''}"
      aria-expanded={expanded}
      onclick={() => toggleExpanded(pane.role)}
    >
      {expanded ? "Show less" : "Show more"}
      <CaretDownIcon
        size={10}
        style="transition:transform 150ms ease;transform:rotate({expanded ? 180 : 0}deg)"
      />
    </button>
  {/if}

  {#if pane.truncated}
    <p class="m-0 mt-2 text-xs text-muted-foreground opacity-70">
      Stored text was capped{pane.chars
        ? ` — ${pane.chars.toLocaleString()} characters were sent`
        : ""}.
    </p>
  {/if}
{/snippet}

<!-- Who spoke and its own copy control, as a caption on the side its words are
     on. Muted and unweighted: the bubble and the prose carry the roles, and a
     bold heading over each would put the labels back in charge of the card.
     The backend's logo keeps its own brand ink while the name beside it stays
     muted, so the speaker is recognised before the caption is read. A muted
     hairline carries each caption away from its message without adding another
     container: after the agent on the left, before the user on the right. -->
{#snippet roleLine(pane: TranscriptPane, alignEnd = false)}
  <div class="flex h-5 items-center gap-1.5 text-xs {alignEnd ? 'justify-end' : ''}">
    <span class="flex shrink-0 items-center gap-1.5 text-muted-foreground">
      {#if pane.mark === "user"}
        <UserIcon size={12} aria-hidden="true" />
      {:else}
        <ProviderMark mark={pane.mark} />
      {/if}
      {pane.label}
    </span>
    {#if pane.text}
      <CopyButton text={pane.text} title={pane.copyTitle} iconOnly />
    {/if}
    <span
      class="h-px flex-1 bg-[var(--hairline)]"
      class:order-first={alignEnd}
      aria-hidden="true"
    ></span>
  </div>
{/snippet}

<section
  class="overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="Summary"
>
  <header
    class="flex h-10 items-center gap-2.5 px-5 text-xs shadow-[inset_0_-0.5px_0_var(--hairline)]"
  >
    <h2 class="m-0 shrink-0 text-sm font-medium">Summary</h2>
    <span class="flex-1"></span>
    {#if meta}
      <span class="shrink-0 truncate text-muted-foreground tabular-nums">{meta}</span>
    {/if}
    {#if !empty}
      <CopyButton text={transcriptAsText(panes)} title="Copy the whole turn" iconOnly />
    {/if}
  </header>

  <div class="flex flex-col gap-4 px-5 pt-3.5 pb-5">
    {#if ask}
      <!-- Right, and held to a message's width: the transcript's own shape for
           a person's words, so the ask is recognised before it is read. -->
      <div class="flex flex-col items-end gap-1.5">
        {@render roleLine(ask, true)}
        {#if ask.text}
          <div
            class="max-w-[41.25rem] min-w-0 rounded-2xl bg-[color-mix(in_oklch,var(--foreground)_2%,transparent)] px-3.5 py-2.5"
          >
            {@render body(ask, "max-h-52", true)}
          </div>
        {:else}
          <p class="m-0 max-w-[76ch] text-right text-xs leading-relaxed text-muted-foreground">
            {ask.emptyNote}
          </p>
        {/if}
      </div>
    {/if}

    {#if answer}
      <!-- Left, on the card's own ground and at the full column: a reply is
           read, not weighed, so it gets no container of its own. -->
      <div class="flex min-w-0 flex-col gap-1.5">
        {@render roleLine(answer)}
        {#if answer.text}
          {@render body(answer, "max-h-[26rem]")}
        {:else}
          <p class="m-0 max-w-[76ch] text-xs leading-relaxed text-muted-foreground text-pretty">
            {answer.emptyNote}
          </p>
        {/if}
      </div>
    {/if}
  </div>

  {#if instructions}
    <!-- Under the card's own hairline: reference text a reader opens on
         purpose, not a third turn in the exchange. -->
    <div class="shadow-[inset_0_0.5px_0_var(--hairline)]">
      <div class="flex h-9 items-center gap-2 pr-3 pl-2.5 text-xs">
        <button
          type="button"
          class="flex h-7 min-w-0 flex-1 overflow-hidden cursor-pointer items-center gap-2 rounded px-2 text-left text-muted-foreground transition-colors select-none hover:bg-[var(--wash-1)] hover:text-foreground"
          aria-expanded={instructionsOpen}
          onclick={() => (instructionsOpen = !instructionsOpen)}
        >
          <CaretDownIcon
            size={10}
            style="flex-shrink:0;opacity:0.55;transition:transform 150ms ease;transform:rotate({instructionsOpen
              ? 0
              : -90}deg)"
          />
          <span class="shrink-0">{instructions.label}</span>
          {#if instructions.meta}
            <span class="truncate tabular-nums opacity-70">{instructions.meta}</span>
          {/if}
          {#if !instructions.text}
            <span class="truncate opacity-60">not recorded</span>
          {/if}
        </button>
        {#if instructions.text}
          <CopyButton text={instructions.text} title={instructions.copyTitle} iconOnly />
        {/if}
      </div>

      {#if instructionsOpen}
        <div class="px-5 pb-4">
          {#if instructions.text}
            {@render body(instructions, "max-h-72")}
          {:else}
            <p class="m-0 max-w-[76ch] text-xs leading-relaxed text-muted-foreground text-pretty">
              {instructions.emptyNote}
            </p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  /* The three texts use the responsive Summary rung: one step below the main
     transcript, but large enough to read as a summary rather than chart
     annotation. It is 14px on desktop and 12px on a laptop, and carries the
     user's text-size preference at both sizes.

     Written here, not as a utility: `.prose-transcript` and `.prose-reading`
     are unlayered, so a `text-*` utility in `@layer utilities` never wins. */
  .transcript-text {
    font-size: var(--text-insights-summary);
    line-height: 1.7;
  }
  /* Headings inside a recorded answer follow the text down; left alone they
     would sit two rungs above their own paragraphs. */
  .transcript-text :global(h1) {
    font-size: var(--text-insights-summary-heading);
  }
  .transcript-text :global(h2),
  .transcript-text :global(h3),
  .transcript-text :global(h4),
  .transcript-text :global(h5),
  .transcript-text :global(h6),
  .transcript-text :global(table) {
    font-size: var(--text-insights-summary);
  }

  /* Fades the last lines of a clipped text so a cut never reads as a text that
     happens to end mid-sentence. A mask rather than an overlaid gradient: the
     texts sit on the card, on the ask's bubble, and on the reader's own theme,
     and a painted gradient would have to guess which. */
  .transcript-cut {
    mask-image: linear-gradient(to bottom, black calc(100% - 3rem), transparent);
  }
</style>
