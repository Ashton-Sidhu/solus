<script lang="ts">
  /** The Safari compass. Apple publishes no logo file, so this draws its dial and needle. */
  let { class: className = "" }: { class?: string } = $props();
  // Gradient ids are document-global: each mark on screen needs its own.
  const uid = $props.id();
</script>

<svg viewBox="0 0 64 64" class={className} aria-hidden="true">
  <defs>
  <linearGradient id="{uid}-dial" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#19D7FF"/>
  <stop offset="1" stop-color="#1E64F0"/>
  </linearGradient>
  <linearGradient id="{uid}-bezel" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#FFFFFF"/>
  <stop offset="1" stop-color="#E4E6EA"/>
  </linearGradient>
  </defs>
  <circle cx="32" cy="32" r="31.5" fill="url(#{uid}-bezel)" stroke="#000000" stroke-opacity="0.12" stroke-width="0.5"/>
  <circle cx="32" cy="32" r="28.5" fill="url(#{uid}-dial)"/>
  <path d="M32.00 5.40L32.00 8.60M34.78 5.55L34.57 7.53M37.53 5.98L37.11 7.94M40.22 6.70L39.60 8.60M42.82 7.70L42.01 9.53M45.30 8.96L43.70 11.74M47.64 10.48L46.46 12.10M49.80 12.23L48.46 13.72M51.77 14.20L50.28 15.54M53.52 16.36L51.90 17.54M55.04 18.70L52.26 20.30M56.30 21.18L54.47 21.99M57.30 23.78L55.40 24.40M58.02 26.47L56.06 26.89M58.45 29.22L56.47 29.43M58.60 32.00L55.40 32.00M58.45 34.78L56.47 34.57M58.02 37.53L56.06 37.11M57.30 40.22L55.40 39.60M56.30 42.82L54.47 42.01M55.04 45.30L52.26 43.70M53.52 47.64L51.90 46.46M51.77 49.80L50.28 48.46M49.80 51.77L48.46 50.28M47.64 53.52L46.46 51.90M45.30 55.04L43.70 52.26M42.82 56.30L42.01 54.47M40.22 57.30L39.60 55.40M37.53 58.02L37.11 56.06M34.78 58.45L34.57 56.47M32.00 58.60L32.00 55.40M29.22 58.45L29.43 56.47M26.47 58.02L26.89 56.06M23.78 57.30L24.40 55.40M21.18 56.30L21.99 54.47M18.70 55.04L20.30 52.26M16.36 53.52L17.54 51.90M14.20 51.77L15.54 50.28M12.23 49.80L13.72 48.46M10.48 47.64L12.10 46.46M8.96 45.30L11.74 43.70M7.70 42.82L9.53 42.01M6.70 40.22L8.60 39.60M5.98 37.53L7.94 37.11M5.55 34.78L7.53 34.57M5.40 32.00L8.60 32.00M5.55 29.22L7.53 29.43M5.98 26.47L7.94 26.89M6.70 23.78L8.60 24.40M7.70 21.18L9.53 21.99M8.96 18.70L11.74 20.30M10.48 16.36L12.10 17.54M12.23 14.20L13.72 15.54M14.20 12.23L15.54 13.72M16.36 10.48L17.54 12.10M18.70 8.96L20.30 11.74M21.18 7.70L21.99 9.53M23.78 6.70L24.40 8.60M26.47 5.98L26.89 7.94M29.22 5.55L29.43 7.53" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="0.7" stroke-linecap="round"/>
  <g transform="rotate(45 32 32)">
  <path d="M32 8.5 35.6 32H28.4Z" fill="#FF3B30"/>
  <path d="M32 55.5 28.4 32H35.6Z" fill="#FFFFFF"/>
  <circle cx="32" cy="32" r="1.4" fill="#FFFFFF" stroke="#000000" stroke-opacity="0.15" stroke-width="0.4"/>
  </g>
</svg>
