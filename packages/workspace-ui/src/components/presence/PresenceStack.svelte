<script lang="ts">
  import type { Snippet } from "svelte";
  import * as TooltipUI from "../ui/tooltip";
  import PresenceAvatar from "./PresenceAvatar.svelte";
  import { stackPeople, type PresencePerson } from "./lib/presence-people";

  /**
   * A row of overlapping faces, oldest arrival first, with a count once it
   * would run long. Nothing in it is for the reader themselves: the store has
   * already left them out. Hovering names everyone, including the ones the
   * count stands for; the optional trigger snippet lets a caller wrap the row
   * in a control of its own (the host stack's menu).
   */
  interface Props {
    people: PresencePerson[];
    size?: 14 | 16 | 18 | 20 | 24;
    /** Faces shown before the count takes over. */
    max?: number;
    /** The user whose turn is running here, ringed in the row. */
    activeUserId?: string | null;
    /** One line per person under the names, e.g. "typing…" or where they are. */
    detail?: (person: PresencePerson) => string | null;
    class?: string;
    /** Rendered in place of the plain row when the stack is a control. */
    trigger?: Snippet<[{ shown: PresencePerson[]; overflow: number }]>;
    /** Off when a caller opens its own roster on click: a tooltip and a menu on one element fight. */
    tooltip?: boolean;
  }
  let { people, size = 18, max = 3, activeUserId = null, detail, class: className = "", trigger, tooltip = true }: Props = $props();

  const stacked = $derived(stackPeople(people, max));
  // The overlap is a fixed share of the diameter so the row reads the same at every size.
  const overlap = $derived(Math.round(size * 0.3));
</script>

{#snippet faces()}
  <span class="inline-flex items-center" style="padding-left:{overlap}px">
    {#each stacked.shown as person (person.userId)}
      <PresenceAvatar
        {person}
        {size}
        ringed={person.userId === activeUserId}
        composing={person.isComposing}
        class="ring-[1.5px] ring-background"
        --overlap="{overlap}px"
      />
    {/each}
    {#if stacked.overflow > 0}
      <span
        class="relative inline-flex shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)] font-medium leading-none text-(--solus-text-secondary) ring-[1.5px] ring-background"
        style="width:{size}px;height:{size}px;font-size:{Math.max(7, Math.round(size * 0.4))}px;margin-left:-{overlap}px"
        aria-hidden="true">+{stacked.overflow}</span
      >
    {/if}
  </span>
{/snippet}

{#if people.length > 0 && !tooltip}
  <span class="inline-flex shrink-0 items-center {className}" data-testid="presence-stack" data-count={people.length}>
    {#if trigger}
      {@render trigger({ shown: stacked.shown, overflow: stacked.overflow })}
    {:else}
      {@render faces()}
    {/if}
  </span>
{:else if people.length > 0}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <span {...props} class="inline-flex shrink-0 items-center {className}" data-testid="presence-stack" data-count={people.length}>
          {#if trigger}
            {@render trigger({ shown: stacked.shown, overflow: stacked.overflow })}
          {:else}
            {@render faces()}
          {/if}
        </span>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content side="bottom" class="items-stretch p-0 text-left font-normal">
      <ul class="flex min-w-32 flex-col gap-0.5 p-1.5">
        {#each people as person (person.userId)}
          {@const line = detail?.(person) ?? null}
          <li class="flex items-center gap-2 rounded px-1 py-0.5">
            <PresenceAvatar {person} size={16} ringed={person.userId === activeUserId} composing={person.isComposing} />
            <span class="flex min-w-0 flex-col">
              <span class="truncate font-medium">{person.displayName}</span>
              {#if line}<span class="truncate text-(--solus-text-tertiary)">{line}</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
    </TooltipUI.Content>
  </TooltipUI.Root>
{/if}

<style>
  /* Each face after the first tucks under its neighbour by the row's overlap. */
  [data-testid="presence-stack"] :global([data-presence-user]) {
    margin-left: calc(-1 * var(--overlap, 0px));
  }
</style>
