<script lang="ts">
  import { untrack } from "svelte";
  import { frontMatterProperties, type FrontMatterProperty } from "./lib/front-matter";

  /**
   * A document's YAML front matter as a list of properties.
   *
   * One-line values edit in place and commit on blur or Enter. Lists, maps,
   * and block scalars show their YAML and change in the source view, so an
   * edit here can never reshape the structure a tool reads.
   */
  interface Props {
    yaml: string;
    /** Read when a field takes focus: a node view is not told when the
     *  editor turns read-only. */
    isEditable: () => boolean;
    onCommit: (key: string, value: string) => void;
    /** Hands focus back to the document after Enter or Escape. */
    onDone: () => void;
  }

  let { yaml, isEditable, onCommit, onDone }: Props = $props();

  // Owned here so an outside edit (undo, the source editor) can replace it
  // through `setYaml`.
  let current = $state(untrack(() => yaml));
  let isReadOnly = $state(untrack(() => !isEditable()));
  const properties = $derived(frontMatterProperties(current));

  export function setYaml(next: string): void {
    current = next;
  }

  function commit(property: FrontMatterProperty, field: HTMLTextAreaElement) {
    if (isReadOnly || field.value === property.value) return;
    onCommit(property.key, field.value);
  }

  function onKeydown(property: FrontMatterProperty, event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
    if (event.key === "Escape") event.currentTarget.value = property.value;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.currentTarget.blur();
    onDone();
  }

  // `field-sizing: content` grows the field with its text. Where the engine
  // lacks it, size the field to its content on each input instead.
  function fitHeight(field: HTMLTextAreaElement) {
    if (CSS.supports("field-sizing", "content")) return;
    const fit = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    };
    fit();
    field.addEventListener("input", fit);
    return () => field.removeEventListener("input", fit);
  }
</script>

<!-- Reads as the document's code block does: a mono caption above a hairline
     rule, and no box. The rule turns terracotta while a field has focus, the
     same cue a focused code block gives. Values keep the document's own face
     and size, so a skill's description reads as prose. -->
<div class="group mb-[1.6em]" contenteditable="false">
  <div class="mb-2 font-[family-name:var(--solus-doc-mono,var(--solus-code-font-family))] text-xs tracking-[0.06em] text-(--solus-text-tertiary) uppercase select-none">
    Properties
  </div>
  <div class="border-l border-(--solus-art-border) pl-4 transition-colors duration-(--duration-quick) ease-(--ease-premium) group-focus-within:border-l-[0.09375rem] group-focus-within:border-(--solus-accent)">
    {#if properties.length === 0}
      <div class="text-(--solus-text-tertiary)">No properties</div>
    {:else}
      <dl class="m-0 grid grid-cols-[fit-content(40%)_minmax(0,1fr)] items-baseline gap-x-6 gap-y-1">
        {#each properties as property}
          <dt class="truncate font-[family-name:var(--solus-doc-mono,var(--solus-code-font-family))] text-[0.875em] text-(--solus-text-tertiary)" title={property.key}>{property.key}</dt>
          <dd class="m-0 min-w-0">
            {#if property.isEditable}
              <textarea
                class="-mx-1.5 block w-[calc(100%+0.75rem)] resize-none rounded-md border-0 bg-transparent px-1.5 py-0.5 [font:inherit] text-inherit outline-none field-sizing-content read-only:cursor-default hover:not-read-only:bg-(--solus-surface-hover) focus:not-read-only:bg-(--solus-surface-hover)"
                rows="1"
                value={property.value}
                readonly={isReadOnly}
                spellcheck="false"
                aria-label={property.key}
                {@attach fitHeight}
                onfocus={() => (isReadOnly = !isEditable())}
                onblur={(event) => commit(property, event.currentTarget)}
                onkeydown={(event) => onKeydown(property, event)}
              ></textarea>
            {:else}
              <!-- Not a <pre>: the document styles every <pre> as a code block. -->
              <div class="py-0.5 font-[family-name:var(--solus-doc-mono,var(--solus-code-font-family))] text-[0.875em] whitespace-pre-wrap">{property.value}</div>
            {/if}
          </dd>
        {/each}
      </dl>
    {/if}
  </div>
</div>
