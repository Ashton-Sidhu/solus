<script lang="ts">
  import { Check as CheckIcon } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { subagentFigures, subagentRail, subagentVerdict } from "./lib/subagent-card";
  import type { SubagentRow } from "./lib/subagent-group";
  import TranscriptCard from "./TranscriptCard.svelte";
  import SubagentIdentity from "./SubagentIdentity.svelte";

  /**
   * §3b — a subagent once it lands. The card opens a body because now there is
   * something to read: the agent's own first paragraph, set as prose, and the
   * files it wrote as a figure table. The rail names the provider, model and
   * reasoning effort.
   */
  interface Props {
    message: Message;
    row: SubagentRow;
    tabId: string;
    skipMotion?: boolean;
  }
  let { message, row, tabId, skipMotion = false }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  const verdict = $derived(subagentVerdict(message));
  const figures = $derived(subagentFigures(message));
  const railText = $derived(subagentRail(row));
  const isOpen = $derived(
    router.overlay?.name === "subagent" && router.overlay.params.messageId === row.id,
  );
</script>

{#snippet glyph()}<CheckIcon />{/snippet}

{#snippet rail()}
  <SubagentIdentity provider={row.provider} modelLabel={row.modelLabel} effortLabel={row.effortLabel} />
  {#if railText}<span>{railText}</span>{/if}
{/snippet}

{#snippet report()}
  {#if verdict}
    <p class="m-0 text-pretty" data-testid="subagent-verdict">{verdict}</p>
  {/if}
  {#if figures.length > 0}
    <!-- A figure table, not a metadata row: counts align down one right edge, so
         they can be compared without being read as a sentence. -->
    <div class="flex flex-col" class:mt-2.5={!!verdict}>
      {#each figures as item (item.label)}
        <div
          class="flex items-baseline gap-2.5 border-t-[0.5px] border-(--solus-tx-divider) py-1.5 text-transcript-meta"
        >
          <span class="w-7 shrink-0 text-right tabular-nums">{item.figure}</span>
          <span class="min-w-0 flex-1 text-muted-foreground text-pretty"
            >{item.label}{#if item.names.length > 0}
              — {#each item.names as name, i (name)}{#if i > 0}, {/if}<span
                  class="text-foreground">{name}</span
                >{/each}{#if item.more > 0}<span class="opacity-70"> +{item.more} more</span
                >{/if}{/if}</span
          >
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

<TranscriptCard
  title={row.name}
  open={isOpen}
  actionLabel="Open report"
  ariaLabel={`Open report: ${row.name}`}
  glyphClass="is-done"
  onOpen={() => session.openSubagent(tabId, row.id)}
  data-testid="subagent-card"
  {skipMotion}
  {glyph}
  {rail}
  body={verdict || figures.length > 0 ? report : undefined}
/>
