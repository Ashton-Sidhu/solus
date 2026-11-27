<script lang="ts">
  import { Lock as LockIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";

  interface Props {
    incorrect: boolean;
    disabled?: boolean;
    onSubmit: (password: string) => void;
  }

  let { incorrect, disabled = false, onSubmit }: Props = $props();
  let password = $state("");
  const statusId = `file-password-status-${Math.random().toString(36).slice(2, 9)}`;

  function handleSubmit(event: SubmitEvent) {
    event.preventDefault();
    event.stopPropagation();
    const submitted = password;
    password = "";
    if (!submitted || disabled) return;
    onSubmit(submitted);
  }
</script>

<form
  class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6"
  data-testid="file-password-prompt"
  onsubmit={handleSubmit}
>
  <LockIcon size={24} class="text-(--solus-text-tertiary)" />
  <p
    id={statusId}
    role={incorrect ? "alert" : "status"}
    class="text-center text-workspace-chrome {incorrect ? 'text-(--solus-status-error)' : 'text-(--solus-text-primary)'}"
  >
    {incorrect ? "Incorrect password. Try again." : "This file requires a password."}
  </p>
  <div class="flex w-full max-w-xs items-center gap-2">
    <div class="min-w-0 flex-1">
      <Input
        type="password"
        name="password"
        bind:value={password}
        aria-label="File password"
        aria-describedby={statusId}
        placeholder="File password"
        autocomplete="off"
        dictation={false}
        autofocus
        required
        {disabled}
      />
    </div>
    <Button type="submit" size="sm" disabled={disabled || password.length === 0}>
      Unlock
    </Button>
  </div>
</form>
