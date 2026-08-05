<script lang="ts">
  import solusIcon from "../../../../../resources/icon.iconset/icon_32x32@2x.png";
  import { avatarTint, type ListPerson } from "./list-page";

  /** A person on a list row. 16px in the global list, 22px in the inbox — the
   *  inbox row is taller and its actor is the subject of the sentence, so it
   *  gets the extra space. The fill/text pair is one hashed tint so the same
   *  person reads the same colour across both pages. */
  interface Props {
    person: ListPerson;
    size?: 16 | 22;
  }
  let { person, size = 16 }: Props = $props();

  const tint = $derived(avatarTint(person.id));
</script>

<span
  class="relative flex shrink-0 items-center justify-center text-[9.5px] font-semibold tracking-[.02em] {person.fallback ===
  'solus'
    ? ''
    : 'rounded-full shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)_inset]'}"
  style="width: {size}px; height: {size}px; {person.fallback === 'solus'
    ? ''
    : `background: color-mix(in oklch, var(${tint}) 22%, transparent); color: color-mix(in oklch, var(${tint}) 72%, var(--foreground))`}"
  title={person.name ?? person.id}
>
  {#if person.fallback === "solus"}
    <!-- The branded mark stands for "nobody is assigned, an agent is". It is a
         glyph, not a person, so it carries none of an avatar's circle: no
         round crop and no ring. -->
    <img src={solusIcon} alt="" class="size-full object-contain" />
  {:else}
    {person.initials}
    {#if person.avatarUrl}
      <img
        src={person.avatarUrl}
        alt=""
        class="absolute size-full rounded-full object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.1)_inset] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.1)_inset]"
        onerror={(event) => (event.currentTarget.style.display = "none")}
      />
    {/if}
  {/if}
</span>
