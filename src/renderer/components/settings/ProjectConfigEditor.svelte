<script lang="ts">
  import { tick, onDestroy } from "svelte";
  import {
    PlayCircleIcon,
    PlusIcon,
    TrashIcon,
  } from "phosphor-svelte";
  import { getProjectConfigStore } from "../../contexts/project-config.store.svelte";
  import { getRunStore } from "../../contexts/run.store.svelte";

  interface Props {
    cwd: string;
  }
  let { cwd }: Props = $props();

  const projectConfig = getProjectConfigStore();
  const runStore = getRunStore();

  interface Row {
    id: string;
    name: string;
    command: string;
    port: string;
  }

  let rows = $state<Row[]>([]);
  let status = $state<"idle" | "saving" | "saved">("idle");
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let commandInputs = $state<HTMLInputElement[]>([]);
  const anyRunning = $derived(
    (runStore.runsFor(cwd) ?? []).some(
      (r) => r.state === "running" || r.state === "starting",
    ),
  );

  $effect(() => {
    if (!cwd) return;
    void projectConfig.load(cwd).then((loaded) => {
      rows = (loaded?.runCommands ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name ?? "",
        command: entry.command,
        port: entry.port ? String(entry.port) : "",
      }));
      if (rows.length === 0) addRow();
      void tick().then(() => commandInputs[0]?.focus());
    });
  });

  function addRow() {
    rows.push({ id: crypto.randomUUID(), name: "", command: "", port: "" });
  }

  function removeRow(index: number) {
    rows.splice(index, 1);
    // Structural change — persist immediately rather than waiting on the debounce.
    void save();
  }

  // Debounce text edits so we don't write the config on every keystroke.
  function scheduleSave() {
    status = "saving";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), 600);
  }

  async function save() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    status = "saving";
    const runCommands = rows
      .filter((row) => row.command.trim())
      .map((row) => {
        const port = row.port.trim() ? Number(row.port) : undefined;
        return {
          id: row.id,
          name: row.name.trim() || undefined,
          command: row.command.trim(),
          port: port && Number.isFinite(port) ? port : undefined,
        };
      });
    await projectConfig.save(cwd, { runCommands });
    await runStore.refreshProjectConfig(cwd);
    status = "saved";
  }

  // Flush a pending debounced save when switching projects or closing settings.
  onDestroy(() => {
    if (saveTimer) void save();
  });

  const inputClass =
    "min-h-8 border border-(--solus-container-border) rounded-lg bg-(--solus-input-bg-soft) text-(--solus-text-primary) px-2.5 text-[0.75rem] outline-none placeholder:text-(--solus-text-tertiary) placeholder:opacity-70 focus:border-(--solus-accent) focus:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_30%,transparent)]";
</script>

<div class="flex flex-col">
  <section class="flex flex-col">
    <h2
      class="text-(--solus-text-tertiary) text-[0.65625rem] font-semibold tracking-[0.05em] uppercase"
    >
      Runs
    </h2>
    <div class="flex items-center justify-between gap-4 py-3.5 pb-2.5">
      <div class="flex items-center gap-3 min-w-0">
        <PlayCircleIcon
          size={16}
          class="shrink-0 text-(--solus-text-tertiary)"
        />
        <div>
          <div class="text-[0.8125rem] font-medium text-(--solus-text-primary)">
            Run commands
          </div>
          <div class="text-[0.6875rem] text-(--solus-text-tertiary) mt-px">
            Commands shown in the Run panel. Each gets its own logs and detected
            ports; set a port to override auto-detection.
          </div>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-2 pb-3.5">
      {#each rows as row, index (row.id)}
        <div class="flex items-center gap-2">
          <input
            bind:value={row.name}
            oninput={scheduleSave}
            name="run-name-{index}"
            class="{inputClass} w-36 shrink-0"
            placeholder="Name (optional)"
            aria-label="Command name"
          />
          <input
            bind:this={commandInputs[index]}
            bind:value={row.command}
            oninput={scheduleSave}
            name="run-command-{index}"
            class="{inputClass} flex-1 min-w-0 font-(--solus-code-font-family)"
            placeholder="npm run dev"
            aria-label="Run command"
          />
          <input
            bind:value={row.port}
            oninput={scheduleSave}
            name="run-port-{index}"
            inputmode="numeric"
            class="{inputClass} w-[4.5rem] shrink-0"
            placeholder="Port"
            aria-label="Port override"
          />
          <button
            type="button"
            class="w-7 h-7 inline-flex items-center justify-center shrink-0 border-none rounded-md bg-transparent text-(--solus-text-tertiary) cursor-pointer hover:bg-(--solus-status-error-bg) hover:text-(--solus-status-error) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
            aria-label="Remove command"
            onclick={() => removeRow(index)}
          >
            <TrashIcon size={13} />
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="self-start inline-flex items-center gap-1.5 min-h-7 px-2.5 border border-dashed border-(--solus-container-border) rounded-lg bg-transparent text-(--solus-text-tertiary) text-[0.71875rem] cursor-pointer hover:text-(--solus-text-primary) hover:border-(--solus-accent) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
        onclick={addRow}
      >
        <PlusIcon size={12} /> Add command
      </button>
    </div>
  </section>

  <div class="mt-4 flex items-center gap-3 min-h-5">
    {#if status === "saving"}
      <span class="text-[0.75rem] text-(--solus-text-tertiary)">Saving…</span>
    {:else if status === "saved"}
      <span class="text-[0.75rem] text-(--solus-text-tertiary)"
        >All changes saved</span
      >
    {/if}
    {#if anyRunning}
      <span class="text-[0.75rem] text-(--solus-text-tertiary)">
        Restart running commands to apply changes.
      </span>
    {/if}
  </div>
</div>
