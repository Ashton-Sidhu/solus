<script lang="ts">
  import { untrack } from "svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { configValueText, modelSettingOptions } from "@solus/client-core/app-config";
  import type { AppConfigState, AppSummary } from "@solus/contracts/apps";
  import { getTextGenerationSettingsStore } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { Button } from "../../ui/button";
  import CodeEditor from "../../code-editor/CodeEditor.svelte";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { configCodeMarks, configEditSummary, configEntryAtLine, configRangeText, configTypeText, replaceConfigValue } from "./lib/config-document";
  import { ConfigEditor } from "./lib/config-editor.svelte";

  /**
   * The config the active version declares (docs/plans/apps.md §4.4), as one
   * JSON document in a code editor. A changed line says what it was, a line at
   * its default says so, and a value the field does not take is a problem
   * under its line with its quick fix. Save sends each changed field once, and
   * waits while there is a problem. Beside the editor, the field at the cursor.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    config: AppConfigState[] | undefined;
  }
  let { serverId, app, config }: Props = $props();

  // A model setting offers the models this host can run (docs/plans/app-models.md §4).
  const textGenerationSettings = getTextGenerationSettingsStore();
  const declaresModel = $derived(config?.some((field) => field.type === "model") ?? false);
  $effect(() => {
    const hostId = serverId;
    if (!declaresModel) return;
    untrack(() => void textGenerationSettings.load({ serverId: hostId, api: serverConnections.apiFor(hostId) }).catch(() => {}));
  });
  const hostModels = $derived(textGenerationSettings.snapshotFor(serverId)?.agents ?? []);

  const editor = new ConfigEditor(() => ({ serverId, appId: app.id, config: config ?? [] }));
  const analysis = $derived(editor.analysis);
  const problemCount = $derived(analysis.problems.length);
  const marks = $derived(configCodeMarks(analysis));

  let cursor = $state({ line: 2, column: 1 });
  /** The field of the last line the cursor was on that holds one: the inspector keeps it while the cursor is on a brace. */
  let inspectedName = $state<string | null>(null);
  const inspected = $derived.by(() => {
    const atCursor = configEntryAtLine(analysis, cursor.line)?.field;
    if (atCursor) return atCursor;
    return config?.find((field) => field.name === inspectedName) ?? config?.[0] ?? null;
  });
  const inspectedEntry = $derived(inspected ? (analysis.entries.find((entry) => entry.name === inspected.name) ?? null) : null);
  const inspectedFix = $derived(inspectedEntry ? (analysis.problems.find((problem) => problem.line === inspectedEntry.line)?.fix ?? null) : null);

  let codeEditor = $state<ReturnType<typeof CodeEditor> | null>(null);

  function moveCursor(line: number, column: number) {
    cursor = { line, column };
    const field = configEntryAtLine(analysis, line)?.field;
    if (field) inspectedName = field.name;
  }

  /** Writes `valueText` as the field's value in the document, as an edit Save sends. */
  function setValue(field: AppConfigState, valueText: string) {
    const change = replaceConfigValue(editor.text, analysis, field.name, valueText);
    if (change) codeEditor?.replace(change);
  }

  async function save() {
    if (await editor.save()) codeEditor?.focus();
  }
</script>

<ManageSectionState
  count={config?.length}
  error={appsStore.stateErrorFor(serverId, app.id)}
  empty="This app declares no config. A setting is declared in app.ts; change the code and deploy to add one."
  onRetry={() => void appsStore.loadState(serverId, app.id)}
>
  <div class="flex min-w-0 items-start gap-9 pt-1.5 @max-[56rem]/pane:flex-col" data-testid="app-config">
    <!-- The editor: the one card of the section. -->
    <section
      class="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_20px_rgb(0_0_0/0.04)] @max-[56rem]/pane:w-full dark:bg-card dark:shadow-none"
      aria-label="Config editor"
    >
      <div class="flex h-12 min-w-0 shrink-0 items-center gap-3 border-b border-border/60 bg-[var(--wash-1)] pr-3.5 pl-1.5">
        <span class="flex h-9 min-w-0 shrink-0 items-center gap-2 rounded-[10px] border border-border bg-background px-3 dark:bg-card">
          <span class="font-mono text-[12.5px] leading-4 text-foreground">config.json</span>
          {#if editor.isEdited}<span class="text-xs leading-4 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]">Edited</span>{/if}
        </span>
        <span class="min-w-0 flex-1"></span>
        {#if editor.isEdited}
          <span class="truncate text-[13px] leading-4 text-(--solus-text-tertiary) tabular-nums" aria-live="polite" data-testid="app-config-summary">{configEditSummary(analysis)}</span>
        {/if}
        <Button size="sm" variant="ghost" class="shrink-0 rounded-full text-(--solus-text-secondary)" disabled={!editor.isEdited || editor.isSaving} onclick={() => editor.discard()}>Discard</Button>
        <Button
          size="sm"
          class="shrink-0"
          disabled={!editor.canSave}
          title={problemCount > 0 ? "Fix the problems to save" : undefined}
          onclick={() => void save()}
          data-testid="app-config-save"
        >
          {editor.isSaving ? "Saving…" : "Save"}
          <kbd class="font-sans text-xs opacity-60">⌘S</kbd>
        </Button>
      </div>

      <CodeEditor
        bind:this={codeEditor}
        value={editor.text}
        onChange={(text) => editor.edit(text)}
        ariaLabel="config.json"
        problems={marks.problems}
        lineMarks={marks.lines}
        onCursor={moveCursor}
        onSave={() => void save()}
        class="overflow-x-auto"
        testId="app-config-editor"
      />

      <div class="flex min-h-9.5 min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 bg-[var(--wash-1)] px-4.5 py-2 text-xs leading-4">
        <span class={problemCount > 0 ? "text-destructive" : "text-(--solus-text-tertiary)"} role="status">
          {problemCount === 0 ? "No problems" : problemCount === 1 ? "1 problem" : `${problemCount} problems`}
        </span>
        <span class="text-(--solus-text-tertiary) tabular-nums">Ln {cursor.line}, Col {cursor.column}</span>
        <span class="min-w-0 truncate text-(--solus-text-tertiary) @max-[40rem]/pane:hidden">A saved change applies from the next call</span>
        <span class="min-w-0 flex-1"></span>
        <Button size="xs" variant="ghost" class="text-(--solus-text-secondary)" disabled={editor.isSaving} onclick={() => editor.resetAll()}>Reset all to defaults</Button>
      </div>
    </section>

    <!-- The field at the cursor: plain on the page. -->
    {#if inspected}
      <aside class="flex w-65 shrink-0 flex-col gap-5.5 pt-3 @max-[56rem]/pane:w-full" aria-label="The setting at the cursor" data-testid="app-config-inspector">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs leading-4 font-medium tracking-[0.06em] text-(--solus-text-tertiary) uppercase">At the cursor</span>
          <h3 class="m-0 text-[17px] leading-5.5 font-semibold tracking-[-0.01em] text-foreground">{inspected.label}</h3>
          <span class="font-mono text-xs text-(--solus-text-tertiary)">{inspected.name}</span>
          {#if inspected.description}<p class="m-0 text-[13px] leading-5 text-pretty text-(--solus-text-tertiary)">{inspected.description}</p>{/if}
        </div>

        <dl class="m-0 flex flex-col text-[13px] leading-4">
          <div class="flex justify-between gap-4 border-t border-border/60 py-2.5">
            <dt class="text-(--solus-text-tertiary)">Type</dt>
            <dd class="m-0 text-right text-foreground">{configTypeText(inspected)}</dd>
          </div>
          {#if configRangeText(inspected)}
            <div class="flex justify-between gap-4 border-t border-border/60 py-2.5">
              <dt class="text-(--solus-text-tertiary)">Range</dt>
              <dd class="m-0 text-right text-foreground tabular-nums">{configRangeText(inspected)}</dd>
            </div>
          {/if}
          <div class="flex justify-between gap-4 border-t border-border/60 py-2.5">
            <dt class="text-(--solus-text-tertiary)">Default</dt>
            <dd class="m-0 min-w-0 truncate text-right text-foreground">{configValueText(inspected, inspected.default)}</dd>
          </div>
          <div class="flex justify-between gap-4 border-y border-border/60 py-2.5">
            <dt class="text-(--solus-text-tertiary)">Saved value</dt>
            <dd class="m-0 min-w-0 truncate text-right text-foreground">{configValueText(inspected, inspected.value)}</dd>
          </div>
        </dl>

        {#if inspected.type === "choice" || inspected.type === "model"}
          {@const options = inspected.type === "model" ? modelSettingOptions(hostModels, String(inspected.value)) : inspected.options}
          <div class="flex flex-col gap-2">
            <span class="text-xs leading-4 text-(--solus-text-tertiary)">{inspected.type === "model" ? "Models on this host" : "Options"}</span>
            <div class="flex flex-wrap gap-1.5">
              {#each options as option (option.value)}
                {@const isCurrent = inspectedEntry?.value === option.value}
                <Button size="xs" variant={isCurrent ? "secondary" : "outline"} class="rounded-full" aria-pressed={isCurrent} onclick={() => setValue(inspected, JSON.stringify(option.value))}>
                  {option.label}
                </Button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="flex flex-wrap gap-2">
          {#if inspectedFix}
            <Button size="sm" onclick={() => setValue(inspected, inspectedFix.text)} title="⌘.">{inspectedFix.label}</Button>
          {/if}
          <Button
            size="sm"
            variant="outline"
            class="rounded-full"
            disabled={inspectedEntry?.value === inspected.default}
            onclick={() => setValue(inspected, JSON.stringify(inspected.default))}
          >
            Reset to default
          </Button>
        </div>

        <p class="m-0 text-[13px] leading-5 text-pretty text-(--solus-text-tertiary)">Previews run with the defaults. Agents can read these values but cannot change them.</p>
      </aside>
    {/if}
  </div>
</ManageSectionState>
