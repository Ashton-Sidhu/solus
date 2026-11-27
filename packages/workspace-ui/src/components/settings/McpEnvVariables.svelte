<script lang="ts">
  /**
   * The environment variables of a command (docs/plans/mcp-first-class.md §7.7):
   * one row for each, with its name and, when the form takes values, its value.
   * A value is a secret: it is masked until the person shows it, and the field
   * never shows a saved one. Pasting the lines of a .env file, or names separated
   * by commas, into a name field fills a row for each. The caller owns the form.
   */
  import { onMount, tick } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { Eye, EyeOff, Plus, X } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { pastedVariables } from "./lib/env-text";
  import type { EnvVariableRow, McpCommandForm } from "./lib/mcp-command.svelte";

  interface Props {
    form: McpCommandForm;
    idPrefix: string;
    /** Show a value field in each row: the add dialog takes the values with the command. */
    showValues?: boolean;
    /** The person saved values before: an empty field keeps them. */
    hasSavedValues?: boolean;
    disabled?: boolean;
  }

  let { form, idPrefix, showValues = false, hasSavedValues = false, disabled = false }: Props = $props();

  /** The rows whose value the person chose to show. */
  const shown = new SvelteSet<number>();
  let addButton = $state<HTMLButtonElement | null>(null);
  const saveProblem = $derived(form.problemOf("envNames"));

  // The list opens with one empty row, so the first name needs no click.
  onMount(() => {
    if (form.envRows.length === 0) form.addVariable();
  });

  async function focusName(rowId: number) {
    await tick();
    document.getElementById(`${idPrefix}-name-${rowId}`)?.focus();
  }

  function add() {
    void focusName(form.addVariable().id);
  }

  function remove(row: EnvVariableRow) {
    const index = form.envRows.findIndex((each) => each.id === row.id);
    shown.delete(row.id);
    form.removeVariable(row.id);
    const next = form.envRows[Math.min(index, form.envRows.length - 1)];
    if (next) void focusName(next.id);
    else void tick().then(() => addButton?.focus());
  }

  function onNamePaste(event: ClipboardEvent, row: EnvVariableRow) {
    const variables = pastedVariables(event.clipboardData?.getData("text/plain") ?? "");
    if (!variables) return;
    event.preventDefault();
    // Without value fields, a pasted value would stay in memory with nowhere to see it.
    form.pasteVariables(row.id, showValues ? variables : variables.map((variable) => ({ name: variable.name, value: "" })));
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex flex-col gap-0.5">
    <span id="{idPrefix}-label" class="text-workspace-chrome font-medium text-foreground">Environment variables</span>
    <p id="{idPrefix}-hint" class="text-chrome-dense text-(--solus-text-secondary)">
      {showValues ? "Each value is a secret that only you can use." : "The names only. Each person gives their own values."}
      Paste a .env file into a name to add several at once.
    </p>
  </div>

  {#if form.envRows.length > 0}
    <ul class="flex flex-col gap-2" aria-labelledby="{idPrefix}-label">
      {#each form.envRows as row, index (row.id)}
        {@const problem = form.rowProblem(row)}
        {@const isShown = shown.has(row.id)}
        <li class="flex flex-col gap-1">
          <!-- Only the name and the value wrap: on a narrow pane they stack, and Remove stays at the end of the first line. -->
          <div class="flex items-start gap-2">
            <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Input id="{idPrefix}-name-{row.id}" bind:value={row.name} placeholder={index === 0 ? "API_KEY" : "NAME"} aria-label="Name of variable {index + 1}"
              autocomplete="off" spellcheck={false} dictation={false} {disabled} aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${idPrefix}-problem-${row.id}` : `${idPrefix}-hint`}
              onpaste={(event: ClipboardEvent) => onNamePaste(event, row)}
              class="h-8 min-w-0 flex-[2_1_9rem] text-workspace-chrome" />
            {#if showValues}
              <div class="relative min-w-0 flex-[3_1_11rem]">
                <Input id="{idPrefix}-value-{row.id}" type={isShown ? "text" : "password"} bind:value={row.value}
                  placeholder={hasSavedValues ? "Saved. Type to replace it" : "Value"} aria-label="Value of {row.name.trim() || `variable ${index + 1}`}"
                  autocomplete="off" spellcheck={false} dictation={false} {disabled} class="h-8 w-full min-w-0 pr-8 text-workspace-chrome" />
                <button type="button" class="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  aria-label="{isShown ? 'Hide' : 'Show'} the value of {row.name.trim() || `variable ${index + 1}`}" aria-pressed={isShown} {disabled}
                  onclick={() => (isShown ? shown.delete(row.id) : shown.add(row.id))}>
                  {#if isShown}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
                </button>
              </div>
            {/if}
            </div>
            <Button variant="ghost" size="icon" class="shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-11" aria-label="Remove {row.name.trim() || `variable ${index + 1}`}"
              {disabled} onclick={() => remove(row)}><X size={14} /></Button>
          </div>
          {#if problem}
            <p id="{idPrefix}-problem-{row.id}" role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{problem}</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <div>
    <Button bind:ref={addButton} variant="ghost" size="sm" class="-ml-2 text-workspace-chrome text-(--solus-text-secondary) pointer-coarse:min-h-11" {disabled} onclick={add}>
      <Plus size={14} />Add variable
    </Button>
  </div>

  {#if saveProblem}
    <p role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{saveProblem}</p>
  {/if}
</div>
