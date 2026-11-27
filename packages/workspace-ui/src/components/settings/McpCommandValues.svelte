<script lang="ts">
  /**
   * One masked field for each name of a command's environment variables
   * (docs/plans/mcp-first-class.md §7.7) or of a server's headers, in the rows
   * of the environment variables editor: the fixed name, then its value. A
   * value is a secret: it is masked until the person shows it, and the field
   * never shows a saved one, only that one is saved. The caller owns the drafts
   * and clears them when it hands them to the host.
   */
  import type { SvelteMap } from "svelte/reactivity";
  import { SvelteSet } from "svelte/reactivity";
  import { Eye, EyeOff } from "@lucide/svelte";
  import { Input } from "../ui/input";

  interface Props {
    names: string[];
    values: SvelteMap<string, string>;
    /** The person saved values before: an empty field keeps them. */
    hasSaved: boolean;
    idPrefix: string;
    disabled?: boolean;
    autofocus?: boolean;
  }

  let { names, values, hasSaved, idPrefix, disabled = false, autofocus = false }: Props = $props();

  /** The names whose value the person chose to show. */
  const shown = new SvelteSet<string>();
</script>

<ul class="flex flex-col gap-2">
  {#each names as name, index (name)}
    {@const isShown = shown.has(name)}
    <li class="flex flex-wrap items-center gap-2">
      <label for="{idPrefix}-{name}" class="flex h-8 min-w-0 flex-[2_1_9rem] items-center overflow-hidden rounded-md bg-muted px-2.5 text-workspace-chrome text-foreground" title={name}>
        <span class="truncate">{name}</span>
      </label>
      <div class="relative min-w-0 flex-[3_1_11rem]">
        <!-- svelte-ignore a11y_autofocus -->
        <Input id="{idPrefix}-{name}" type={isShown ? "text" : "password"} bind:value={() => values.get(name) ?? "", (value) => values.set(name, value)}
          placeholder={hasSaved ? "Saved. Type to replace it" : "Value"} autocomplete="off" spellcheck={false} dictation={false} {disabled}
          autofocus={autofocus && index === 0} class="h-8 w-full min-w-0 pr-8 text-workspace-chrome" />
        <button type="button" class="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label="{isShown ? 'Hide' : 'Show'} the value of {name}" aria-pressed={isShown} {disabled}
          onclick={() => (isShown ? shown.delete(name) : shown.add(name))}>
          {#if isShown}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
        </button>
      </div>
    </li>
  {/each}
</ul>
