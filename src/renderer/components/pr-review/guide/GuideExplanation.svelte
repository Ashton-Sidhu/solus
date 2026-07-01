<script lang="ts">
  import { WarningIcon } from "phosphor-svelte";
  import SvelteMarkdown from "@humanspeak/svelte-markdown";
  import type { GuideSection, LedgerRecord } from "../../../../shared/review";
  import { markdownSanitizeUrl } from "../../../lib/markdownSanitize";
  import CodeSpan from "../../ui/CodeSpan.svelte";

  const markdownRenderers = { codespan: CodeSpan };

  // The "why" column of a guide section: the agent's explanation, then the
  // ledger-sourced detail (collapsed), and any author question as a flagged
  // callout. `records` are the LedgerRecords this section's refs resolved to.
  let { section, records }: { section: GuideSection; records: LedgerRecord[] } = $props();

  // Fields worth surfacing in the collapsible deeper-detail block.
  const DETAIL_FIELDS = [
    { key: "why", label: "Why this way" },
    { key: "assumptions", label: "Assumptions" },
    { key: "alternatives", label: "Alternatives" },
    { key: "edgeCases", label: "Edge cases" },
  ] as const;

  const detailRecords = $derived(
    records.filter((r) => r.why || r.assumptions || r.alternatives || r.edgeCases),
  );
  const questions = $derived(
    records.map((r) => r.question).filter((q): q is string => !!q && q.trim().length > 0),
  );
</script>

<div class="flex flex-col gap-3.5">
  <div class="prose-cloud prose-reading text-(--solus-text-secondary)">
    <SvelteMarkdown source={section.explanation} renderers={markdownRenderers} sanitizeUrl={markdownSanitizeUrl} />
  </div>

  {#each questions as question (question)}
    <div
      class="flex items-start gap-2 rounded-lg border border-[color:color-mix(in_srgb,var(--solus-art-negative)_38%,transparent)] bg-[color:color-mix(in_srgb,var(--solus-art-negative)_8%,transparent)] px-3 py-2.5"
    >
      <WarningIcon size={15} weight="fill" class="mt-0.5 shrink-0 text-(--solus-art-negative)" />
      <p class="text-[0.875rem] leading-relaxed text-(--solus-text-primary)">{question}</p>
    </div>
  {/each}

  {#if detailRecords.length > 0}
    <details class="group rounded-lg border border-(--solus-art-border) bg-(--solus-art-surface) px-3 py-2">
      <summary
        class="flex cursor-pointer list-none items-center gap-1.5 text-[0.875rem] font-semibold text-(--solus-text-tertiary) select-none"
      >
        <span
          class="inline-block size-1.5 rotate-45 border-r-[1.5px] border-b-[1.5px] border-current transition-transform duration-150 group-open:rotate-[225deg]"
        ></span>
        Why · assumptions · edge cases
      </summary>
      <div class="detail-body mt-2.5 flex flex-col gap-3">
        {#each detailRecords as record (record.id)}
          <div class="flex flex-col gap-1.5">
            <span class="text-[0.875rem] font-semibold text-(--solus-text-primary)">{record.title}</span>
            {#each DETAIL_FIELDS as field (field.key)}
              {#if record[field.key]}
                <div class="flex flex-col gap-0.5">
                  <span class="text-[0.6875rem] font-semibold tracking-wide text-(--solus-text-tertiary) uppercase">
                    {field.label}
                  </span>
                  <span class="text-[0.875rem] leading-relaxed text-(--solus-text-secondary)">
                    {record[field.key]}
                  </span>
                </div>
              {/if}
            {/each}
          </div>
        {/each}
      </div>
    </details>
  {/if}
</div>

<style>
  /* Native <details> shows its body instantly; fade+lift it in on open so the
     disclosure resolves rather than snapping. Runs once each open (the body
     transitions from display:none, which restarts the animation). */
  details[open] .detail-body {
    animation: detail-body-in 0.2s ease-out;
  }
  @keyframes detail-body-in {
    from {
      opacity: 0;
      transform: translateY(-0.25rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    details[open] .detail-body {
      animation: none;
    }
  }
</style>
