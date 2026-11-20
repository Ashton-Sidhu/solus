<script lang="ts">
  /**
   * One masked field for each environment variable name of a command
   * (docs/plans/mcp-first-class.md §7.7). A value is a secret: the field never
   * shows a saved one, only that one is saved. The caller owns the drafts and
   * clears them when it hands them to the host.
   */
  import type { SvelteMap } from "svelte/reactivity";
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
</script>

<div class="flex flex-col gap-2.5">
  {#each names as name, index (name)}
    <div class="flex flex-col gap-1.5">
      <label for="{idPrefix}-{name}" class="font-mono text-chrome-dense text-(--solus-text-secondary)">{name}</label>
      <!-- svelte-ignore a11y_autofocus -->
      <Input id="{idPrefix}-{name}" type="password" bind:value={() => values.get(name) ?? "", (value) => values.set(name, value)}
        placeholder={hasSaved ? "Saved. Type to replace it" : "Value"} autocomplete="off" spellcheck={false} dictation={false} {disabled}
        autofocus={autofocus && index === 0} class="h-8 min-w-0 text-workspace-chrome" />
    </div>
  {/each}
</div>
