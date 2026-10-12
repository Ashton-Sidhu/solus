<script lang="ts">
  interface Props {
    size?: number;
    class?: string;
    "aria-label"?: string;
  }

  let {
    size = 24,
    class: className = "",
    "aria-label": ariaLabel,
  }: Props = $props();
</script>

<!-- Windows mark from Simple Icons. Lucide has no Windows logo, so a generic
     panel layout stood in for it. The canvas is padded like AppleLogoIcon so
     `size` matches the Lucide icons beside it. -->
<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="-2.4 -2.4 28.8 28.8"
  fill="currentColor"
  class={className}
  role={ariaLabel ? "img" : undefined}
  aria-label={ariaLabel}
  aria-hidden={ariaLabel ? undefined : "true"}
  focusable="false"
>
  <path
    d="M0 0h11.377v11.372H0Zm12.623 0H24v11.372H12.623ZM0 12.623h11.377V24H0Zm12.623 0H24V24H12.623"
  />
</svg>
