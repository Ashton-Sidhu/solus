<script lang="ts">
  import { Play as RunIcon } from "@lucide/svelte";
  import type { AppOperation } from "@solus/contracts/apps";
  import { operationFields, operationInputTemplate, operationKindLabel, operationSchemaNode, operationTimeLimitText, type OperationField } from "@solus/client-core/app-operations";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { isMac } from "../../../lib/keybindings/match";
  import { formatDuration } from "../../insights/lib/format";
  import CodeEditor from "../../code-editor/CodeEditor.svelte";
  import { jsonSchemaCompletionSource, jsonSchemaProblems } from "../../code-editor/lib/json-schema";
  import { Button } from "../../ui/button";
  import { hasSchema, jsonText, operationInput, runOperation, spanSummary } from "./lib/operations";

  /**
   * The request console of the Operations section (docs/plans/apps.md §9.2):
   * one card that runs one operation as the app's UI does. The request
   * column has the JSON input in the code editor, which starts from the
   * operation's fields, completes them from its input schema, and marks a
   * field or a value the schema does not take; and what it takes; the response column has the status, the time, the value,
   * and what the call waited for. ⌘↵ runs it.
   */
  interface Props {
    serverId: string;
    appId: string;
    operation: AppOperation;
    /** Why the operation cannot run now; null when it can. */
    refusal: string | null;
    /** Opens the calls of this operation in Activity; absent where no section can open. */
    onOpenActivity?: () => void;
  }
  let { serverId, appId, operation, refusal, onOpenActivity }: Props = $props();

  type Response = ({ ok: true; value: string } | { ok: false; error: string }) & { durationMs: number | null; summary: string | null };

  const inputFields = $derived(operationFields(operation.input));
  const outputFields = $derived(operation.output ? operationFields(operation.output) : []);
  const takesInput = $derived(inputFields === null || inputFields.length > 0);
  // The form starts from the fields of the schema it opened with; another operation re-mounts the console.
  // svelte-ignore state_referenced_locally
  let inputText = $state(operationFields(operation.input)?.length === 0 ? "" : operationInputTemplate(operation.input));
  let isRunning = $state(false);
  let response = $state<Response | null>(null);
  let showsSchemas = $state(false);
  const runKey = isMac ? "⌘↵" : "Ctrl↵";
  const inputSchema = $derived(operationSchemaNode(operation.input));
  const inputProblems = $derived(jsonSchemaProblems(inputText, inputSchema));
  const completeInput = jsonSchemaCompletionSource(() => inputSchema);

  async function run() {
    if (isRunning || refusal !== null) return;
    const input = operationInput(takesInput ? inputText : "");
    if (!input.ok) {
      response = { ok: false, error: input.error, durationMs: null, summary: null };
      return;
    }
    isRunning = true;
    const hostId = serverId;
    const id = appId;
    const name = operation.name;
    const startedAt = Date.now();
    let outcome: Response;
    try {
      const value = await runOperation((callName, argumentsJson) => appsStore.call(hostId, id, callName, argumentsJson), name, input.value);
      outcome = { ok: true, value: jsonText(value), durationMs: Date.now() - startedAt, summary: null };
    } catch (cause) {
      outcome = { ok: false, error: cause instanceof Error ? cause.message : "The call failed.", durationMs: Date.now() - startedAt, summary: null };
    }
    // The call log has the run: its own time, and what it waited for. A host that cannot say keeps the time of the round trip.
    try {
      const call = await appsStore.latestUiCall(hostId, id, name, startedAt - 1000);
      if (call) outcome = { ...outcome, durationMs: call.durationMs ?? outcome.durationMs, summary: spanSummary(call.spans) };
    } catch {
      // The value is the answer; the line under it is extra.
    }
    response = outcome;
    isRunning = false;
  }
</script>

{#snippet fieldTable(label: string, list: OperationField[] | null, none: string)}
  <div class="flex min-w-0 flex-col">
    <h4 class="m-0 border-b border-border/60 pb-2 text-sm font-medium text-foreground">{label}</h4>
    {#if list === null}
      <p class="m-0 py-2 text-[13px] text-(--solus-text-secondary)">A shape the JSON schema describes.</p>
    {:else if list.length === 0}
      <p class="m-0 py-2 text-[13px] text-(--solus-text-secondary)">{none}</p>
    {:else}
      <dl class="m-0 flex flex-col">
        {#each list as field (field.name)}
          <div class="flex min-w-0 flex-col gap-0.5 border-b border-border/50 py-2 last:border-b-0">
            <div class="flex min-w-0 items-baseline justify-between gap-3">
              <dt class="min-w-0 truncate text-sm text-foreground">{field.name}</dt>
              <dd class="m-0 shrink-0 text-[13px] text-(--solus-text-secondary)">{field.type}{field.required ? " · required" : ""}</dd>
            </div>
            {#if field.description}
              <dd class="m-0 text-[13px] text-pretty text-(--solus-text-secondary)">{field.description}</dd>
            {/if}
          </div>
        {/each}
      </dl>
    {/if}
  </div>
{/snippet}

<section
  class="grid min-w-0 grid-cols-1 overflow-hidden rounded-2xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_20px_rgb(0_0_0/0.04)] @min-[60rem]/pane:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] dark:bg-card dark:shadow-none"
  aria-label="Run {operation.name}"
  data-testid="app-operation-runner"
>
  <div class="flex min-w-0 flex-col">
    <header class="flex min-w-0 items-start gap-3 px-5 pt-4 pb-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <h3 class="m-0 truncate text-base font-semibold text-foreground">{operation.name}</h3>
        <p class="m-0 truncate text-[13px] text-(--solus-text-secondary)" title={operation.description}>
          {operationKindLabel(operation.kind)}{#if operation.description} · {operation.description}{/if}
        </p>
      </div>
      <Button class="shrink-0" disabled={isRunning || refusal !== null} title={refusal ?? `Run ${operation.name} (${runKey})`} onclick={() => void run()}>
        <RunIcon />
        {isRunning ? "Running…" : "Run"}
        <span class="text-xs opacity-70" aria-hidden="true">{runKey}</span>
      </Button>
    </header>

    {#if takesInput}
      <div class="border-y border-border/60 bg-[var(--wash-1)] py-3 pr-5 pl-3">
        <CodeEditor
          value={inputText}
          onChange={(text) => (inputText = text)}
          size="console"
          ariaLabel="Input of {operation.name}, as JSON"
          placeholder={"{}"}
          complete={completeInput}
          extensionsKey={inputSchema}
          problems={inputProblems}
          onRun={() => void run()}
          class="max-h-80 min-h-34 overflow-auto"
          testId="app-operation-input"
        />
      </div>
    {:else}
      <p class="m-0 border-y border-border/60 bg-[var(--wash-1)] px-5 py-3 text-[13px] text-(--solus-text-secondary)">It takes no input. Run calls it with one press.</p>
    {/if}

    <div class="flex min-w-0 flex-col gap-5 px-5 pt-4 pb-5">
      {@render fieldTable("Takes", inputFields, "No input")}
      {@render fieldTable("Answers", outputFields, operation.output ? "An empty object" : "Any value: no output schema")}
      <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-(--solus-text-secondary)">
        <span>Time limit <span class="tabular-nums text-foreground">{operationTimeLimitText(operation.timeoutSeconds)}</span></span>
        <span>{refusal ?? (operation.kind === "mutation" ? "Run changes the app's data, as a call from its UI does." : "It only reads.")}</span>
        {#if hasSchema(operation.input) || hasSchema(operation.output)}
          <Button size="xs" variant="ghost" class="ml-auto text-(--solus-text-secondary)" aria-expanded={showsSchemas} onclick={() => (showsSchemas = !showsSchemas)}>
            {showsSchemas ? "Hide the JSON schemas" : "JSON schemas"}
          </Button>
        {/if}
      </div>
      {#if showsSchemas}
        {#each [["Input", operation.input], ["Output", operation.output]] as const as [label, schema] (label)}
          {#if hasSchema(schema)}
            <div class="flex min-w-0 flex-col gap-1">
              <span class="text-xs text-(--solus-text-secondary)">{label}</span>
              <pre class="m-0 max-h-56 overflow-auto rounded-lg bg-[var(--wash-2)] p-3 font-mono text-xs whitespace-pre">{jsonText(schema)}</pre>
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>

  <div class="flex min-w-0 flex-col gap-3 border-t border-border/60 px-5 pt-4 pb-5 @min-[60rem]/pane:border-t-0 @min-[60rem]/pane:border-l" aria-live="polite">
    <div class="flex min-w-0 items-baseline justify-between gap-3">
      <h4 class="m-0 text-sm font-semibold text-foreground">Response</h4>
      {#if response}
        <span class="shrink-0 text-xs tabular-nums" data-testid="app-operation-status">
          <span class={response.ok ? "text-(--success)" : "text-(--failure)"}>{response.ok ? "OK" : "Failed"}</span>
          {#if response.durationMs !== null}<span class="text-muted-foreground"> · {formatDuration(response.durationMs)}</span>{/if}
        </span>
      {/if}
    </div>
    {#if isRunning}
      <p class="m-0 text-[13px] text-muted-foreground" role="status" aria-busy="true">Running…</p>
    {:else if response?.ok}
      <pre class="m-0 max-h-80 overflow-auto rounded-lg bg-[var(--wash-2)] p-3 font-mono text-xs whitespace-pre select-text" aria-label="Value" data-testid="app-operation-value">{response.value}</pre>
    {:else if response}
      <p class="m-0 text-[13px] text-(--failure) text-pretty select-text" role="alert">{response.error}</p>
    {:else}
      <p class="m-0 text-[13px] text-muted-foreground">Run the operation to see what it answers.</p>
    {/if}
    {#if response?.summary}
      <p class="m-0 text-[13px] text-(--solus-text-secondary) text-pretty">{response.summary}</p>
    {/if}
    {#if onOpenActivity}
      <Button size="xs" variant="link" class="self-start px-0 text-foreground underline underline-offset-4" onclick={onOpenActivity}>Open in Activity</Button>
    {/if}
  </div>
</section>
