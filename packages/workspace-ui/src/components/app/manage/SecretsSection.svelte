<script lang="ts">
  import { tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { KeyRound as KeyIcon, Lock as LockIcon } from "@lucide/svelte";
  import type { AppSecretState, AppSummary } from "@solus/contracts/apps";
  import { serversStore } from "../../../contexts";
  import { appsStore } from "../../../contexts/apps/apps.store.svelte";
  import { toasts } from "../../../lib/toasts";
  import { Button } from "../../ui/button";
  import { Input } from "../../ui/input";
  import ManageSectionState from "./ManageSectionState.svelte";
  import { emptySecretNote, secretVaultSummary } from "./lib/app-secrets";

  /**
   * The secrets the active version declares, as one vault (docs/plans/apps.md
   * §4.4): a slot for each secret. An empty slot is a field to paste the value
   * in; a slot with a value shows only that it has one, and its owner replaces
   * or clears it. A value is never read back. Clear asks first, in its row.
   */
  interface Props {
    serverId: string;
    app: AppSummary;
    /** Undefined until the host answers with the app's state. */
    secrets: AppSecretState[] | undefined;
  }
  let { serverId, app, secrets }: Props = $props();

  const hostLabel = $derived(serversStore.hostFor(serverId)?.label ?? serverId);

  /** What the person pasted in each open field, by secret name. */
  const drafts = new SvelteMap<string, string>();
  /** The slot with a value whose field is open to replace it. */
  let replacingName = $state<string | null>(null);
  /** The slot that asks before it clears its value. */
  let clearingName = $state<string | null>(null);
  let busyName = $state<string | null>(null);

  function openReplace(name: string) {
    clearingName = null;
    drafts.delete(name);
    replacingName = name;
  }

  /** Closes what the row opened and gives the keyboard back to the row's action. */
  async function closeRow(name: string) {
    drafts.delete(name);
    if (replacingName === name) replacingName = null;
    if (clearingName === name) clearingName = null;
    await tick();
    document.querySelector<HTMLElement>(`[data-secret-action="${name}"]`)?.focus();
  }

  function handleFieldKeydown(event: KeyboardEvent, name: string) {
    if (event.key !== "Escape") return;
    // The Manage page must not also take this Escape.
    event.preventDefault();
    event.stopPropagation();
    void closeRow(name);
  }

  async function save(secret: AppSecretState, value: string | null) {
    if (busyName || value === "") return;
    busyName = secret.name;
    try {
      await appsStore.setSecret(serverId, app.id, secret.name, value);
      await closeRow(secret.name);
    } catch (error) {
      toasts.error(value === null ? "The secret was not cleared" : "The secret was not saved", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busyName = null;
    }
  }
</script>

<ManageSectionState
  count={secrets?.length}
  error={appsStore.stateErrorFor(serverId, app.id)}
  empty="This app declares no secret. A secret is declared in app.ts; change the code and deploy to add one."
  onRetry={() => void appsStore.loadState(serverId, app.id)}
>
  <div class="flex min-w-0 flex-col gap-7 pt-1.5" data-testid="app-secrets">
    <!-- The vault: the one card of the section. -->
    <section
      class="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-[0_1px_2px_rgb(0_0_0/0.03),0_6px_20px_rgb(0_0_0/0.04)] dark:bg-card dark:shadow-none"
      aria-labelledby="app-secrets-title"
    >
      <header class="flex min-w-0 items-center gap-4 px-6 pt-5.5 pb-5">
        <span class="flex size-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-background" aria-hidden="true">
          <LockIcon size={20} strokeWidth={1.8} />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-0.75">
          <h3 id="app-secrets-title" class="m-0 truncate text-[17px] leading-5.5 font-semibold tracking-[-0.01em] text-foreground">{app.name}’s secrets</h3>
          <p class="m-0 truncate text-[13px] leading-4 text-(--solus-text-tertiary)">{secretVaultSummary(secrets ?? [], hostLabel)}</p>
        </div>
      </header>

      {#each secrets ?? [] as secret (secret.name)}
        {@const isEmpty = !secret.isSet}
        {@const isReplacing = replacingName === secret.name}
        {@const isClearing = clearingName === secret.name}
        {@const isFieldOpen = isEmpty || isReplacing}
        {@const isBusy = busyName === secret.name}
        {@const draft = drafts.get(secret.name) ?? ""}
        <div
          class="flex min-w-0 flex-col gap-2.5 border-t border-border/60 px-6 py-4.5 {isEmpty ? 'bg-[color-mix(in_oklch,var(--warning)_6%,transparent)]' : ''}"
          data-testid="app-secret"
          data-secret={secret.name}
        >
          <div class="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
            <span
              class="flex size-9 shrink-0 items-center justify-center rounded-[10px] {isEmpty
                ? 'bg-[color-mix(in_oklch,var(--warning)_16%,transparent)] text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]'
                : 'bg-[var(--wash-2)] text-(--solus-text-secondary)'}"
              aria-hidden="true"
            >
              <KeyIcon size={16} strokeWidth={1.8} />
            </span>
            <div class="flex w-57.5 min-w-0 shrink-0 flex-col gap-0.75 @max-[44rem]/pane:w-auto @max-[44rem]/pane:flex-1">
              <span class="truncate font-mono text-[13px] leading-4 font-medium text-foreground">{secret.name}</span>
              <span class="truncate text-[13px] leading-4 text-(--solus-text-tertiary)" title={secret.description || undefined}>{secret.label}</span>
            </div>

            <!-- The value: a field when the slot is open, the confirmation of Clear, or the sign that a value is saved. -->
            <div class="flex min-w-0 flex-1 basis-56 items-center @max-[44rem]/pane:basis-full">
              {#if isFieldOpen}
                <Input
                  type="password"
                  dictation={false}
                  autofocus={isReplacing}
                  autocomplete="off"
                  spellcheck={false}
                  data-1p-ignore
                  class="h-9.5 rounded-[10px] text-sm"
                  aria-label="{isReplacing ? 'New value' : 'Value'} of {secret.name}"
                  placeholder={isReplacing ? "Paste the new value" : "Paste the value"}
                  disabled={isBusy}
                  value={draft}
                  oninput={(event) => drafts.set(secret.name, event.currentTarget.value)}
                  onkeydown={(event) => handleFieldKeydown(event, secret.name)}
                  submitOn="enter"
                  onSubmit={() => void save(secret, draft)}
                  data-testid="app-secret-field"
                />
              {:else if isClearing}
                <p class="m-0 flex h-9.5 min-w-0 flex-1 items-center truncate rounded-[10px] bg-destructive/8 px-3 text-[13px] text-destructive" role="alert">
                  Clear this value? Calls that read it fail until you add one.
                </p>
              {:else}
                <span class="flex h-9.5 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] bg-[var(--wash-1)] px-3 text-(--solus-text-tertiary)">
                  <LockIcon size={14} class="shrink-0" aria-hidden="true" />
                  <span class="truncate text-[15px] leading-4.5 tracking-[0.12em]" aria-label="A value is saved">••••••••••••••••••••</span>
                </span>
              {/if}
            </div>

            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex w-42 shrink-0 items-center justify-end gap-2 @max-[44rem]/pane:ml-auto @max-[44rem]/pane:w-auto"
              onkeydown={(event) => isClearing && handleFieldKeydown(event, secret.name)}
            >
              {#if isFieldOpen}
                {#if isReplacing || draft !== ""}
                  <Button size="sm" variant="ghost" class="rounded-full text-(--solus-text-secondary)" disabled={isBusy} onclick={() => void closeRow(secret.name)}>Cancel</Button>
                {/if}
                <Button size="sm" disabled={isBusy || draft === ""} onclick={() => void save(secret, draft)} data-testid="app-secret-save">
                  {isBusy ? "Saving…" : "Save"}
                </Button>
              {:else if isClearing}
                <!-- svelte-ignore a11y_autofocus -->
                <Button size="sm" variant="ghost" class="rounded-full text-(--solus-text-secondary)" autofocus disabled={isBusy} onclick={() => void closeRow(secret.name)}>Cancel</Button>
                <Button size="sm" variant="destructive" disabled={isBusy} onclick={() => void save(secret, null)} data-testid="app-secret-clear-confirm">
                  {isBusy ? "Clearing…" : "Clear"}
                </Button>
              {:else}
                <Button
                  size="sm"
                  variant="ghost"
                  class="rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={busyName !== null}
                  onclick={() => {
                    replacingName = null;
                    clearingName = secret.name;
                  }}
                  data-testid="app-secret-clear">Clear</Button
                >
                <Button size="sm" variant="outline" class="rounded-full" data-secret-action={secret.name} disabled={busyName !== null} onclick={() => openReplace(secret.name)}>
                  Replace
                </Button>
              {/if}
            </div>
          </div>

          {#if isEmpty}
            <p class="m-0 pl-13 text-[13px] leading-4 text-pretty text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))] @max-[44rem]/pane:pl-0">{emptySecretNote(secret)}</p>
          {:else if isReplacing}
            <p class="m-0 pl-13 text-xs text-(--solus-text-tertiary) @max-[44rem]/pane:pl-0">The new value replaces the saved one. Enter saves, Esc cancels.</p>
          {/if}
        </div>
      {/each}

      <footer class="border-t border-border/60 bg-[var(--wash-1)] px-6 py-3.5 text-[13px] leading-4 text-(--solus-text-tertiary)">
        The app declares its secrets in <code class="font-mono text-[12px]">app.ts</code>. To add or rename one, change the code and deploy.
      </footer>
    </section>

    <!-- What a value is and where it goes: plain notes under the vault. -->
    <dl class="m-0 grid grid-cols-3 gap-10 px-6 @max-[44rem]/pane:grid-cols-1 @max-[44rem]/pane:gap-5">
      <div class="flex min-w-0 flex-col gap-2">
        <dt class="text-xs leading-4 font-medium tracking-[0.06em] text-(--solus-text-tertiary) uppercase">Write only</dt>
        <dd class="m-0 text-[13px] leading-5 text-pretty text-(--solus-text-secondary)">After you save a value, no one can read it back — not you, the app’s UI, or an agent. You can only replace or clear it.</dd>
      </div>
      <div class="flex min-w-0 flex-col gap-2">
        <dt class="text-xs leading-4 font-medium tracking-[0.06em] text-(--solus-text-tertiary) uppercase">Who reads a value</dt>
        <dd class="m-0 text-[13px] leading-5 text-pretty text-(--solus-text-secondary)">The app’s backend, on each call. A new value applies from the next call.</dd>
      </div>
      <div class="flex min-w-0 flex-col gap-2">
        <dt class="text-xs leading-4 font-medium tracking-[0.06em] text-(--solus-text-tertiary) uppercase">Where it is</dt>
        <dd class="m-0 text-[13px] leading-5 text-pretty text-(--solus-text-secondary)">The secret store on {hostLabel}. Values are not in the app’s data, its files, or the call log.</dd>
      </div>
    </dl>
  </div>
</ManageSectionState>
