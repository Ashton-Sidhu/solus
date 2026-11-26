<script lang="ts">
  /**
   * "Welcome to Solus" and the line under it: what is being set up and how far
   * along the person is. A pending organization name is renamed in place
   * (docs/plans/one-page-onboarding.md decision 2): click or Enter opens the
   * field, ↵ saves, esc cancels.
   */
  import { tick } from "svelte";

  interface Props {
    /** The machine, or the organization in the cloud flow. */
    subject: string;
    /** "Step 2 of 4.", or "is ready." once the cloud flow is done. */
    progress: string;
    isReady: boolean;
    /** The signed-in account, shown as a chip. */
    email: string | null;
    /** Present when the subject is an organization name the person may rename now. */
    onrename?: (name: string) => Promise<boolean>;
  }

  let { subject, progress, isReady, email, onrename }: Props = $props();

  let isEditing = $state(false);
  let draft = $state("");
  let isSaving = $state(false);
  let renameError = $state<string | null>(null);
  let field = $state<HTMLInputElement | null>(null);
  let nameButton = $state<HTMLButtonElement | null>(null);

  async function startEditing() {
    draft = subject;
    renameError = null;
    isEditing = true;
    await tick();
    field?.select();
  }

  async function stopEditing() {
    isEditing = false;
    await tick();
    nameButton?.focus();
  }

  async function save() {
    if (!onrename || isSaving) return;
    if (!draft.trim()) return stopEditing();
    isSaving = true;
    const saved = await onrename(draft);
    isSaving = false;
    if (saved) return stopEditing();
    renameError = "Solus Cloud did not save the name. Try again.";
  }

  /** The page's own Enter and Escape stay out of the field. */
  function onFieldKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter") void save();
    else void stopEditing();
  }
</script>

<header class="flex flex-wrap items-end justify-between gap-6 pb-10">
  <div class="flex min-w-0 flex-col gap-2">
    <h1 class="m-0 text-[30px] leading-9 font-semibold tracking-[-0.02em] text-(--solus-text-primary)">Welcome to Solus</h1>
    <p class="m-0 text-[15px] leading-5.5 text-(--solus-text-tertiary)">
      {#if !isReady}Setting up{" "}{/if}{#if isEditing}<input
          bind:this={field}
          bind:value={draft}
          class="h-7.5 w-[16ch] max-w-full rounded-md border-[1.5px] border-(--solus-text-primary) bg-transparent px-2 text-[15px] text-(--solus-text-primary) outline-none"
          aria-label="Organization name"
          maxlength={80}
          disabled={isSaving}
          onkeydown={onFieldKeydown}
          onblur={() => { if (!isSaving) void stopEditing(); }}
        />{" "}· {progress}{:else if onrename}<button
          bind:this={nameButton}
          type="button"
          class="cursor-text rounded-sm text-(--solus-text-primary) underline decoration-dashed decoration-1 underline-offset-[3px] hover:bg-(--wash-2) focus-visible:outline-2 focus-visible:outline-ring"
          title="Rename the organization"
          onclick={() => void startEditing()}
        >{subject}</button>{isReady ? " " : ". "}{progress}{:else}<span class="text-(--solus-text-primary)">{subject}</span>{isReady ? " " : ". "}{progress}{/if}
    </p>
    {#if isEditing}
      <p class="m-0 flex flex-wrap items-center gap-1.5 text-[12px] leading-4 text-(--solus-text-tertiary)">
        <kbd class="rounded-[4px] border border-(--hairline) px-1.25 font-mono text-[11px]">↵</kbd> save
        <kbd class="rounded-[4px] border border-(--hairline) px-1.25 font-mono text-[11px]">esc</kbd> cancel · Members see this name. You can change it later.
      </p>
    {/if}
    {#if renameError}
      <p class="m-0 text-[12px] leading-4 text-(--solus-status-error)" role="alert">{renameError}</p>
    {/if}
  </div>
  {#if email}
    <div class="flex h-7.5 items-center gap-2 rounded-full border border-(--hairline) bg-(--solus-rail-bg) pr-2.5 pl-1">
      <span class="flex size-5.5 shrink-0 items-center justify-center rounded-full bg-(--solus-accent-soft) text-[11px] leading-3.5 font-semibold text-primary" aria-hidden="true">{email.slice(0, 1).toUpperCase()}</span>
      <span class="text-[13px] leading-4.5 text-(--solus-text-secondary)">{email}</span>
    </div>
  {/if}
</header>
