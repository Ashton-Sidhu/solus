<script lang="ts">
  interface Props {
    raw?: string;
    text?: string;
  }

  let { raw = "", text }: Props = $props();

  const HTML_ENTITIES = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  } satisfies Record<string, string>;
  const decodeHtml = (s: string) =>
    s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => HTML_ENTITIES[m]);

  const copyText = $derived(decodeHtml(text ?? raw.replace(/^`+|`+$/g, "")));
</script>

<code>{copyText}</code>
