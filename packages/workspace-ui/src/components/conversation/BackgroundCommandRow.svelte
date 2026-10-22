<script lang="ts">
  import { SquareTerminal as TerminalIcon, CircleAlert as AlertIcon } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import {
    backgroundCommandWake,
    backgroundCommandWakeSummary,
  } from "@solus/client-core/background-command-wake";
  import HostNoticeRow from "./HostNoticeRow.svelte";
  import { TerminalOutput } from "../ui/terminal-output";

  /** A background command's wake as a host notice: a terminal, the command,
   *  and how it ended — "bun test · exit 1". The output tail opens from the
   *  row as the terminal showed it (`TerminalOutput`), never as markdown: a
   *  test runner's `#` and `*` are output, not headings and emphasis, its
   *  colours are kept, and so is every line break. */
  let { message, skipMotion = false }: { message: Message; skipMotion?: boolean } = $props();

  const wake = $derived(backgroundCommandWake(message.content));
  const summary = $derived(wake ? `${wake.command} · ${backgroundCommandWakeSummary(wake)}` : "");
  const ending = $derived(
    wake?.exitCode === null || wake?.exitCode === undefined
      ? "finished after the turn ended."
      : `finished after the turn ended with exit ${wake.exitCode}.`,
  );
</script>

<HostNoticeRow
  {message}
  label="Background command"
  {summary}
  attention={wake?.attention ?? false}
  {skipMotion}
  testid="background-command-row"
>
  {#snippet glyph()}
    {#if wake?.attention}
      <AlertIcon size={11} aria-hidden="true" />
    {:else}
      <TerminalIcon size={11} aria-hidden="true" />
    {/if}
  {/snippet}
  {#snippet detail()}
    {#if wake}
      <p class="m-0 text-transcript-card leading-relaxed text-foreground">
        <code class="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">{wake.command}</code>
        {ending}
      </p>
      {#if wake.output}
        <TerminalOutput output={wake.output} label={`Output of ${wake.command}`} class="mt-2 max-h-80" />
      {/if}
    {/if}
  {/snippet}
</HostNoticeRow>
