<script lang="ts">
  import { ArrowDown as MoveDownIcon, ArrowUp as MoveUpIcon, Plus as AddIcon, Trash2 as DeleteIcon } from "@lucide/svelte";
  import type { SavedLens } from "@solus/contracts/review";
  import { uuid } from "@solus/contracts/uuid";
  import { getSettingsContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { LENS_TEMPLATES } from "../review/lib/lens-surface";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import SettingsTextField from "./SettingsTextField.svelte";

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
    settings.setPersonal("savedLenses", next);
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

  /** A blank lens takes focus so the user can name it straight away. */
  let blankLensId = $state<string | null>(null);

  function add(template?: Omit<SavedLens, "id">) {
    const id = uuid();
    blankLensId = template ? null : id;
    save([...lenses, { id, ...(template ?? { name: "", prompt: "" }) }]);
  }
</script>

<div class="flex flex-col gap-2" data-testid="saved-lenses">
  {#if lenses.length > 0}
    <div class="divide-y divide-border overflow-hidden rounded-lg border border-input bg-white dark:bg-input/30">
      {#each lenses as lens, index (lens.id)}
        <div class="group/lens flex flex-col gap-0.5 px-3 pt-2 transition-colors focus-within:bg-[var(--wash-1)]">
          <div class="flex items-center gap-1">
            <Input
              value={lens.name}
              placeholder="Untitled lens"
              aria-label="Lens name"
              autofocus={lens.id === blankLensId}
              class="h-6 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 font-medium text-workspace-chrome text-(--solus-text-primary) shadow-none focus-visible:ring-0"
              oninput={(event) => change(lens.id, { name: event.currentTarget.value })}
            />
            <div
              class="flex shrink-0 items-center text-(--solus-text-tertiary) opacity-0 transition-opacity group-hover/lens:opacity-100 group-focus-within/lens:opacity-100 pointer-coarse:opacity-100"
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Move {lens.name || 'lens'} up"
                title="Move up"
                disabled={index === 0}
                onclick={() => move(index, -1)}
              >
                <MoveUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Move {lens.name || 'lens'} down"
                title="Move down"
                disabled={index === lenses.length - 1}
                onclick={() => move(index, 1)}
              >
                <MoveDownIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Delete {lens.name || 'lens'}"
                title="Delete"
                class="hover:text-destructive"
                onclick={() => remove(lens.id)}
              >
                <DeleteIcon />
              </Button>
            </div>
          </div>
          <SettingsTextField
            label={lens.name ? `${lens.name} prompt` : 'Lens prompt'}
            value={lens.prompt}
            onValueChange={(value) => change(lens.id, { prompt: value })}
            maxHeight={180}
            placeholder="Describe the view you want for every change: what to show, how to lay it out, what to link."
            class="[--plain-editor-font-size:var(--text-workspace-chrome)] [--plain-editor-line-height:1.5] [--plain-editor-padding:0_1.75rem_0.625rem_0] [&_.cm-content]:![min-height:1.5rem] [&_.cm-content]:![font-weight:400] [&_.cm-content]:![color:var(--solus-text-secondary)]"
          />
        </div>
      {/each}
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-1.5">
    <Button variant="outline" size="xs" onclick={() => add()}>
      <AddIcon />
      Add lens
    </Button>
    {#each unusedTemplates as template (template.name)}
      <Button variant="ghost" size="xs" title={template.prompt} onclick={() => add(template)}>
        <AddIcon />
        {template.name}
      </Button>
    {/each}
  </div>
</div>
