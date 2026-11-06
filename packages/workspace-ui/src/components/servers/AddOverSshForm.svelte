<script lang="ts">
  /** The SSH tab of the add-host dialog: a machine that was not found on the
   *  network (docs/plans/host-routes.md D6). The flow and its decisions live in
   *  `addOverSshStore`; this is the form, the live progress, and the result. */
  import { tick } from "svelte";
  import { LoaderCircle as LoaderIcon } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import { Switch } from "../ui/switch";
  import StatusCard from "../conversation/StatusCard.svelte";
  import DirectoryPicker from "../pickers/DirectoryPicker.svelte";
  import { addOverSshStore as store } from "./add-over-ssh.store.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let targetInput: HTMLInputElement | null = $state(null);
  let passwordInput: HTMLInputElement | null = $state(null);
  let identityInput: HTMLInputElement | null = $state(null);
  let isKeyPickerOpen = $state(false);
  let doneButton = $state<HTMLElement | null>(null);
  let closeButton = $state<HTMLElement | null>(null);

  const isRunning = $derived(store.phase === "running");
  /** Once an add starts, its steps replace the fields; a failed add shows both, to edit and try again. */
  const showsFields = $derived(store.phase === "form");

  // The next thing to type gets the focus: the target on open, the password
  // when SSH asks for it, and Done once the machine is added. While the add
  // runs the fields are gone, so Close keeps the focus in the dialog for Escape.
  $effect(() => {
    if (store.phase === "done") void tick().then(() => doneButton?.focus());
    else if (store.phase === "running") void tick().then(() => closeButton?.focus());
    else if (store.phase === "form") {
      const field = store.isPasswordRequested ? passwordInput : targetInput;
      void tick().then(() => field?.focus());
    }
  });

  // The key is a file on the host that runs SSH, so the picker browses that host.
  function closeKeyPicker() {
    isKeyPickerOpen = false;
    void tick().then(() => identityInput?.focus());
  }

  function chooseKey(path: string) {
    store.identityFile = path;
    closeKeyPicker();
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void store.submit();
  }
</script>

<form class="flex flex-col gap-4" onsubmit={submit}>
  {#if showsFields}
    <div class="grid gap-3 @min-[36rem]/add-host:grid-cols-2">
      <label class="block">
        <span class="mb-1.5 block text-chrome-dense font-medium text-(--solus-text-secondary)">SSH target</span>
        <Input
          bind:ref={targetInput}
          bind:value={store.sshTarget}
          placeholder="user@host or an alias"
          autocomplete="off"
          spellcheck={false}
          dictation={false}
        />
      </label>
      <label class="block">
        <span class="mb-1.5 block text-chrome-dense font-medium text-(--solus-text-secondary)">
          Password {store.isPasswordRequested ? "" : "(only if it has no SSH key)"}
        </span>
        <Input
          bind:ref={passwordInput}
          bind:value={store.password}
          disabled={!!store.passwordIssue}
          type="password"
          autocomplete="current-password"
          dictation={false}
        />
        <span class="mt-1 block text-pretty text-chrome-dense text-(--solus-text-tertiary)">
          {#if store.passwordIssue}
            {store.passwordIssue}
          {:else if store.linkToAccount}
            Used once and never stored.
          {:else}
            Kept in memory on {store.sshHostName} until it restarts. Never stored on disk.
          {/if}
        </span>
      </label>
    </div>

    <div>
      <label for="ssh-identity-file" class="mb-1.5 block text-chrome-dense font-medium text-(--solus-text-secondary)">Identity file (optional)</label>
      <div class="flex gap-2">
        <Input
          id="ssh-identity-file"
          bind:ref={identityInput}
          bind:value={store.identityFile}
          placeholder="~/.ssh/my-key.pem"
          autocomplete="off"
          spellcheck={false}
          dictation={false}
          aria-describedby="ssh-identity-file-hint"
        />
        <Button variant="outline" disabled={!store.sshHostId} onclick={() => (isKeyPickerOpen = true)}>Browse…</Button>
      </div>
      <span id="ssh-identity-file-hint" class="mt-1 block text-chrome-dense text-(--solus-text-tertiary)">
        A private key on {store.sshHostName}, as with ssh -i. Empty: its SSH keys and ~/.ssh/config.
      </span>
    </div>

    <!-- A quiet option, not a decision: one line, its effect said once beside it. -->
    <label class="flex min-w-0 items-center gap-2 text-chrome-dense text-(--solus-text-tertiary)">
      <Switch
        size="sm"
        checked={store.linkToAccount}
        onCheckedChange={(next) => store.setLinkToAccount(next)}
        disabled={!store.canLink}
      />
      <span class="shrink-0 text-(--solus-text-secondary)">Link to my Solus account</span>
      <span class="min-w-0 truncate">
        {#if !store.canLink}
          · Sign in to Solus Cloud to link it
        {:else if store.linkToAccount}
          · every device you sign in on can use it
        {:else}
          · only {store.sshHostName} can use it, through SSH
        {/if}
      </span>
    </label>
  {/if}

  {#if store.statusCard}
    <!-- The same card a run's setup draws; its last step is the result. -->
    <StatusCard card={store.statusCard} keepsStepsOpen />
  {:else if store.error}
    <p class="cursor-text select-text text-pretty text-chrome-dense text-destructive" role="alert">{store.error}</p>
  {/if}

  <div class="flex items-center justify-end gap-2">
    {#if isRunning}
      <!-- Closing does not stop the add: the host finishes it, and the machine is saved. -->
      <span class="mr-auto text-chrome-dense text-(--solus-text-tertiary)">You can close this; the add goes on.</span>
    {/if}
    {#if store.phase === "done"}
      <Button bind:ref={doneButton} onclick={() => onclose()}>Done</Button>
    {:else}
      <Button bind:ref={closeButton} variant="ghost" onclick={() => onclose()}>{isRunning ? "Close" : "Cancel"}</Button>
      <Button type="submit" disabled={!store.canSubmit}>
        {#if isRunning}
          <LoaderIcon size={14} class="animate-spin motion-reduce:animate-none" />
          Adding…
        {:else}
          {store.error ? "Try again" : "Add machine"}
        {/if}
      </Button>
    {/if}
  </div>
</form>

{#if store.sshHostId}
  <DirectoryPicker
    open={isKeyPickerOpen}
    onClose={closeKeyPicker}
    onSelect={chooseKey}
    initialPath="~/.ssh/"
    title="Choose an identity file"
    actionLabel="Choose"
    chooses={(entry) => !entry.isDir}
    api={serverConnections.apiFor(store.sshHostId)}
    hostLabel={store.sshHostName}
    serverId={store.sshHostId}
  />
{/if}
