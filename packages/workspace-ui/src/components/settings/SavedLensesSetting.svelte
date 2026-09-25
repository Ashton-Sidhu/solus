<script lang="ts">
  import { ArrowDown as MoveDownIcon, ArrowUp as MoveUpIcon, Trash2 as DeleteIcon } from "@lucide/svelte";
  import type { SavedLens } from "@solus/contracts/review";
  import { uuid } from "@solus/contracts/uuid";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { LENS_TEMPLATES } from "../review/lib/lens-surface";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import PlainTextEditor from "../ui/plain-text-editor/plain-text-editor.svelte";

  /**
   * Saved lenses: named prompts the Lens tab offers on every review
   * (docs/plans/review-lenses.md). Editing one here never changes a lens that
   * was already made from it — the lens keeps its own copy of the prompt.
   */
  const settings = getSettingsContext();
  const lenses = $derived(settings.savedLenses);
  const unusedTemplates = $derived(
    LENS_TEMPLATES.filter((template) => !lenses.some((lens) => lens.name === template.name)),
  );

  function save(next: SavedLens[]) {
    settings.update({ savedLenses: next });
  }

  function change(id: string, patch: Partial<Omit<SavedLens, "id">>) {
    save(lenses.map((lens) => (lens.id === id ? { ...lens, ...patch } : lens)));
  }

  function move(index: number, offset: -1 | 1) {
    const next = [...lenses];
    const [lens] = next.splice(index, 1);
    next.splice(index + offset, 0, lens);
    save(next);
    requestInputFocus();
  }

  function remove(id: string) {
    save(lenses.filter((lens) => lens.id !== id));
    requestInputFocus();
  }

  function add(template: Omit<SavedLens, "id"> = { name: "", prompt: "" }) {
    save([...lenses, { id: uuid(), ...template }]);
  }
</script>

<div class="flex flex-col gap-3" data-testid="saved-lenses">
  {#each lenses as lens, index (lens.id)}
    <div
      class="flex flex-col overflow-hidden rounded-lg border border-border bg-background transition-[border-color,box-shadow] focus-within:border-(--solus-accent) focus-within:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)]"
    >
      <div class="flex items-center gap-0.5 pt-1 pr-1.5 pl-1">
        <Input
          value={lens.name}
          placeholder="Lens name"
          aria-label="Lens name"
          class="h-7 min-w-0 flex-1 border-0 px-2 font-medium text-workspace-chrome focus-visible:ring-0"
          oninput={(event) => change(lens.id, { name: event.currentTarget.value })}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Move {lens.name || 'lens'} up"
          disabled={index === 0}
          onclick={() => move(index, -1)}
        >
          <MoveUpIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Move {lens.name || 'lens'} down"
          disabled={index === lenses.length - 1}
          onclick={() => move(index, 1)}
        >
          <MoveDownIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Delete {lens.name || 'lens'}" onclick={() => remove(lens.id)}>
          <DeleteIcon />
        </Button>
      </div>
      <PlainTextEditor
        value={lens.prompt}
        onValueChange={(value) => change(lens.id, { prompt: value })}
        ariaLabel="Lens prompt"
        enterInsertsNewline
        hidePlaceholderOnFocus
        maxHeight={180}
        dictation
        placeholder="Describe the view you want for every change: what to show, how to lay it out, what to link."
        class="px-3 [--plain-editor-font-size:var(--text-workspace-chrome)] [--plain-editor-line-height:1.5] [--plain-editor-padding:0_0_0.625rem] [&_.cm-content]:![min-height:2.5rem] [&_.cm-content]:![font-weight:400]"
      />
    </div>
  {/each}

  <div class="flex flex-wrap items-center gap-1.5">
    <Button variant="outline" size="xs" onclick={() => add()}>Add lens</Button>
    {#each unusedTemplates as template (template.name)}
      <Button variant="ghost" size="xs" title={template.prompt} onclick={() => add(template)}>
        + {template.name}
      </Button>
    {/each}
  </div>
</div>
