<script lang="ts">
  import { Button } from "../ui/button";
  import { Input } from "../ui/input";

  interface Props {
    onClose: () => void;
    onSave: (name: string) => Promise<void>;
  }

  let { onClose, onSave }: Props = $props();

  let name = $state("");
  let saving = $state(false);

  async function save(): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName || saving) return;

    saving = true;
    try {
      await onSave(trimmedName);
    } finally {
      saving = false;
    }
  }
</script>

<!-- Browser prompts are blocked or absent on some Solus clients. Naming a
     saved query is part of the app, so it uses the same in-app modal grammar as
     the other naming flows. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  data-solus-ui
  class="fixed inset-0 z-[10020] flex items-start justify-center bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] px-4 pt-[18vh] pointer-events-auto motion-safe:animate-[backdrop-fade_140ms_ease-out]"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
  onkeydown={(event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }}
>
  <div
    class="save-query-enter flex w-[clamp(18rem,38vw,26rem)] max-w-[calc(100vw-3rem)] origin-top flex-col gap-3 rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) p-[1.125rem] shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.34)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45),0_4.375rem_8.125rem_-3.125rem_rgba(0,0,0,0.55)]"
    role="dialog"
    aria-label="Save query"
    aria-modal="true"
  >
    <div class="flex flex-col gap-1">
      <span class="text-[0.8125rem] font-medium">Save query</span>
      <span class="text-xs text-(--solus-text-tertiary)">
        Give this query a name so you can run it again.
      </span>
    </div>
    <Input
      bind:value={name}
      autofocus
      placeholder="Query name"
      aria-label="Query name"
      onSubmit={() => void save()}
      submitOn="enter"
      disabled={saving}
    />
    <div class="flex justify-end gap-2">
      <Button variant="ghost" size="sm" onclick={onClose} disabled={saving}>Cancel</Button>
      <Button size="sm" onclick={() => void save()} disabled={!name.trim() || saving}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  </div>
</div>

<style>
  /* Keyframes cannot be expressed as Tailwind utilities. `backwards`, not
     `both`: a retained end transform keeps the panel on its own compositing
     layer and blurs its text (see index.css msg-in-up note). */
  .save-query-enter {
    animation: save-query-enter 180ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
  }

  @media (prefers-reduced-motion: reduce) {
    .save-query-enter {
      animation: none;
    }
  }

  @keyframes save-query-enter {
    from {
      opacity: 0;
      transform: translate3d(0, 0.25rem, 0) scale(0.985);
    }
    to {
      opacity: 1;
      transform: translate3d(0, 0, 0) scale(1);
    }
  }
</style>
