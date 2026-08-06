<!--
@component
The leaf text node of a rendered markdown body, with HTML entities decoded —
see `decodeHtmlEntities`. Overriding `rawtext` is what routes every plain-text
run through here; code spans and fenced blocks have their own renderers, so
their entities stay literal the way GitHub shows them.
-->
<script lang="ts">
  import { decodeHtmlEntities } from "../../lib/githubMarkdown";

  interface Props {
    text?: string;
  }
  const { text = "" }: Props = $props();
</script>

{decodeHtmlEntities(text)}
