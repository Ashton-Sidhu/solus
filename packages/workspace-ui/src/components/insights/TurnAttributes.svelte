<script lang="ts">
  import { ChevronDown as CaretDownIcon } from "@lucide/svelte";
  import CopyButton from "../ui/CopyButton.svelte";
  import * as TooltipUI from "../ui/tooltip";
  import {
    attributeCount,
    attributesAsText,
    isPrimaryGroup,
    type TurnAttribute,
    type TurnAttributeGroup,
  } from "./lib/turn-attributes";

  /**
   * Every fact the turn recorded, grouped and copyable.
   *
   * Three things this surface owes the reader, and the app's global
   * `user-select: none` denies by default:
   *
   * - **Readable rows.** Long keys and values truncate to keep the list easy
   *   to scan. Their tooltips preserve the complete recorded text.
   * - **Copy.** Every row carries its own control, which copies the stored
   *   value rather than the rounded one on screen; the header copies the list.
   * - **A way through the length.** A turn carries around forty attributes.
   *   The groups a reader opens first are shown; the rest are one control away.
   *   The full-page turn surface already scrolls, so opening this card must
   *   grow it instead of putting the new rows below an unchanged inner fold.
   */
  interface Props {
    groups: TurnAttributeGroup[];
    onOpenTask?: (taskId: string) => void;
  }

  let { groups, onOpenTask }: Props = $props();

  let expanded = $state(false);

  const total = $derived(attributeCount(groups));
  const visibleGroups = $derived(
    expanded
      ? groups
      : groups.filter(isPrimaryGroup),
  );
  const hiddenCount = $derived(total - attributeCount(visibleGroups));

  function toneColor(attribute: TurnAttribute): string {
    if (attribute.tone === "failure") return "var(--failure)";
    if (attribute.tone === "warning") return "var(--warning)";
    return "var(--foreground)";
  }
</script>

<section
  class="flex flex-col overflow-hidden rounded-xl bg-card shadow-[shadow:var(--insights-card-shadow)]"
  aria-label="Attributes"
>
  <header class="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
    <h2 class="m-0 text-insights-chrome font-normal text-muted-foreground uppercase">Attributes</h2>
    <span class="text-insights-chrome tabular-nums text-muted-foreground opacity-60">{total}</span>
    <span class="flex-1"></span>
    <CopyButton text={attributesAsText(groups)} title="Copy every attribute" iconOnly />
  </header>

  <div class="flex min-h-0 flex-col gap-2.5 px-1.5 pb-2">
    {#each visibleGroups as group (group.label)}
      <div class="flex flex-col">
        <h3
          class="sticky top-0 z-1 m-0 bg-card px-1.5 pt-1 pb-1 text-[0.625rem] font-normal text-muted-foreground uppercase opacity-70"
        >
          {group.label}
        </h3>
        {#each group.attributes as attribute (attribute.key)}
          <!-- The copy control is a column of its own, not an overlay: a 28px
               button positioned against a 20px row can only be aligned by
               guessing at line boxes. The track is always there, so revealing
               the button on hover moves nothing. -->
          <div
            class="group/attr grid min-h-7 items-center gap-2 rounded-md py-0.5 pl-1.5 transition-colors hover:bg-[var(--wash-1)]"
            style="grid-template-columns:minmax(0,3fr) minmax(0,2fr) 1.75rem"
          >
            <TooltipUI.Root>
              <TooltipUI.Trigger>
                {#snippet child({ props })}
                  {#if attribute.note}
                    <button
                      {...props}
                      type="button"
                      class="min-w-0 truncate cursor-help border-0 bg-transparent p-0 text-left text-[0.6875rem] leading-[1.5] text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 select-text focus-visible:rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_oklch,var(--primary)_45%,transparent)]"
                    >{attribute.key}</button
                    >
                  {:else}
                    <span
                      {...props}
                      class="block min-w-0 truncate text-[0.6875rem] leading-[1.5] text-muted-foreground select-text"
                      >{attribute.key}</span
                    >
                  {/if}
                {/snippet}
              </TooltipUI.Trigger>
              <TooltipUI.Content class="max-w-64 flex-col items-start font-normal">
                <span class="max-w-full wrap-anywhere {attribute.mono ? 'font-mono' : ''}">{attribute.key}</span>
                {#if attribute.note}
                  <span class="text-muted-foreground">{attribute.note}</span>
                {/if}
              </TooltipUI.Content>
            </TooltipUI.Root>
            <span class="min-w-0">
              <TooltipUI.Root>
                <TooltipUI.Trigger>
                  {#snippet child({ props })}
                    {#if attribute.destination?.name === "task" && onOpenTask}
                      <button
                        {...props}
                        type="button"
                        class="block w-full truncate cursor-pointer border-0 bg-transparent p-0 text-left text-[0.6875rem] leading-[1.5] text-primary underline decoration-primary/35 underline-offset-4 select-text transition-colors hover:decoration-primary focus-visible:rounded-sm focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_oklch,var(--primary)_45%,transparent)] active:scale-[0.96]"
                        title="Open task in the trailing pane"
                        onclick={() => onOpenTask(attribute.destination!.taskId)}
                      >{attribute.value}</button
                      >
                    {:else}
                      <span
                        {...props}
                        class="block truncate text-[0.6875rem] leading-[1.5] select-text {attribute.mono
                          ? 'font-mono'
                          : 'tabular-nums'}"
                        style="color:{toneColor(attribute)}">{attribute.value}</span
                      >
                    {/if}
                  {/snippet}
                </TooltipUI.Trigger>
                <TooltipUI.Content
                  value={attribute.value}
                  class="max-w-64 wrap-anywhere font-normal {attribute.mono ? 'font-mono' : ''}"
                />
              </TooltipUI.Root>
            </span>
            <!-- Revealed on hover or keyboard focus so forty rows do not read
                 as forty buttons, but never absent from the tab order. -->
            <span
              class="flex justify-center opacity-0 transition-opacity group-hover/attr:opacity-100 focus-within:opacity-100"
            >
              <CopyButton text={attribute.copyValue} title="Copy {attribute.key}" iconOnly />
            </span>
          </div>
        {/each}
      </div>
    {/each}
  </div>

  {#if hiddenCount > 0 || expanded}
    <button
      type="button"
      class="flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 text-[0.6875rem] text-muted-foreground shadow-[inset_0_0.5px_0_var(--hairline)] transition-colors select-none hover:bg-[var(--wash-1)] hover:text-foreground"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? "Show less" : `Show all ${total} attributes`}
      <CaretDownIcon
        size={10}
        style="transition:transform 150ms ease;transform:rotate({expanded ? 180 : 0}deg)"
      />
    </button>
  {/if}
</section>
