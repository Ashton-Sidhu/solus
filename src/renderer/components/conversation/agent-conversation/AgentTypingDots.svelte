<script lang="ts">
  /**
   * The other agent is writing. Three dots in its colour, sitting in the slot
   * its reply will occupy — never beside a status sentence, a spinner or an
   * elapsed clock, because the dots replace all three.
   *
   * `pill` is the body treatment; `chip` is the smaller, unpilled form that
   * lives inside a switchboard tab, where several agents may be writing at once
   * and stacking indicators in the body would be unreadable.
   */
  interface Props {
    variant?: "pill" | "chip";
  }
  let { variant = "pill" }: Props = $props();
</script>

<span
  class="flex items-center w-fit {variant === 'pill'
    ? 'gap-1 px-2.5 py-1.5 rounded-xl bg-[color-mix(in_oklch,var(--agent-accent)_13%,transparent)]'
    : 'gap-[3px]'}"
  aria-label="writing a reply"
>
  {#each [0, 1, 2] as dot (dot)}
    <span
      class="agent-typing-dot rounded-full bg-[color-mix(in_oklch,var(--agent-accent)_80%,var(--foreground))] {variant ===
      'pill'
        ? 'size-[4.5px]'
        : 'size-1'}"
    ></span>
  {/each}
</span>
