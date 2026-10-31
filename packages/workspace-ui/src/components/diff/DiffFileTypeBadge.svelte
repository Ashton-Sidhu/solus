<script lang="ts">
  import FileIcon from "../ui/file-icon/FileIcon.svelte";

  let { path }: { path: string } = $props();
</script>

<FileIcon {path} />
