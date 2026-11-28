<script lang="ts">
  /**
   * A user name and a password for a server that asks for HTTP Basic
   * (`basic-credentials.ts`), in place of the API key field. Both leave this
   * form as one encoded key in the call that saves it; the password field is
   * cleared, and comes back only when the host refuses the key. Shared by the
   * connect dialog, the Settings row, and the conversation's connect card.
   */
  import { tick } from "svelte";
  import { basicCredentials, basicUsernameError } from "@solus/contracts/integrations/basic-credentials";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";
  import TranscriptCardAction from "../conversation/TranscriptCardAction.svelte";

  interface Props {
    idPrefix: string;
    /** The host's or the cloud's refusal of the last try. */
    error?: string;
    disabled?: boolean;
    /** The connect card's buttons. */
    compact?: boolean;
    autofocus?: boolean;
    /** Saves the encoded key; false when it was refused. */
    onsubmit: (key: string) => Promise<boolean>;
    oncancel?: () => void;
  }

  let { idPrefix, error, disabled = false, compact = false, autofocus = false, onsubmit, oncancel }: Props = $props();

  let username = $state("");
  let password = $state("");
  let usernameError = $state<string | null>(null);
  let usernameEl = $state<HTMLInputElement | null>(null);
  const shownError = $derived(usernameError ?? error);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    usernameError = basicUsernameError(username);
    if (usernameError) {
      await tick();
      usernameEl?.focus();
      return;
    }
    const typed = password;
    password = "";
    if (!(await onsubmit(basicCredentials(username, typed)))) password = typed;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !oncancel) return;
    event.preventDefault();
    event.stopPropagation();
    oncancel();
  }
</script>

<!-- Escape from either field cancels, as it does in the API key field. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form class="flex flex-col gap-2.5" onsubmit={submit} onkeydown={onKeydown}>
  <div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-username" class={compact ? "text-transcript-meta text-(--muted-foreground)" : "text-workspace-chrome font-medium text-foreground"}>User name</label>
    <!-- svelte-ignore a11y_autofocus -->
    <Input id="{idPrefix}-username" type="text" bind:value={username} bind:ref={usernameEl} {autofocus} autocomplete="off" spellcheck={false} dictation={false} {disabled}
      class="h-8 min-w-0 text-workspace-chrome" aria-invalid={usernameError ? true : undefined} aria-describedby={shownError ? `${idPrefix}-error` : undefined}
      oninput={() => { usernameError = null; }} />
  </div>
  <div class="flex flex-col gap-1.5">
    <label for="{idPrefix}-password" class={compact ? "text-transcript-meta text-(--muted-foreground)" : "text-workspace-chrome font-medium text-foreground"}>Password</label>
    <Input id="{idPrefix}-password" type="password" bind:value={password} autocomplete="off" spellcheck={false} dictation={false} {disabled}
      class="h-8 min-w-0 text-workspace-chrome" aria-invalid={error && !usernameError ? true : undefined} aria-describedby={shownError ? `${idPrefix}-error` : undefined} />
  </div>
  {#if shownError}
    <p id="{idPrefix}-error" role="alert" class="break-words text-chrome-dense text-(--solus-status-error)">{shownError}</p>
  {/if}
  <div class="flex flex-wrap items-center gap-2">
    {#if compact}
      {#if oncancel}<TranscriptCardAction kind="ghost" onclick={oncancel}>Cancel</TranscriptCardAction>{/if}
      <TranscriptCardAction kind="filled" type="submit" disabled={disabled || !username}>Submit</TranscriptCardAction>
    {:else}
      {#if oncancel}
        <Button variant="ghost" size="sm" class="text-muted-foreground pointer-coarse:min-h-11" onclick={oncancel}>Cancel</Button>
      {/if}
      <Button type="submit" size="sm" class="pointer-coarse:min-h-11" disabled={disabled || !username}>Submit</Button>
    {/if}
  </div>
</form>
