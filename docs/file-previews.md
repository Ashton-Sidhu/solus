# File previews

File-name chips in assistant messages open the Files pane with the file
selected and any linked line revealed. Text files inside
the session's project or worktree support editing and autosave on desktop,
web, and mobile. Files outside that directory and text previews truncated at
1 MiB are read-only. For HTML files, select Source to edit the markup.

For Markdown files, select Editor or Markdown in the outlined control in the
pane header. Editor opens the rich-text editor; Markdown opens the source.
The selected view is remembered on each desktop, web, or mobile client.

File view controls and Settings use the same shared segmented control: an
outlined track with a raised selection. Each segment fits its label with
equal horizontal padding. File headers use the compact size: 24 px high
with lighter labels and less padding. Touch controls retain their larger
height.

The Files pane displays PNG, JPEG, GIF, WebP, and SVG files as read-only images. Images fit within the pane on desktop,
web, and mobile. SVG files use an image element, not an executable HTML frame.

The host reads image bytes through `readProjectFile` and returns a data URL.
Remote clients do not need access to the host filesystem. Images have a 10 MB
limit; larger images show an error instead of a partial preview. Unsupported
binary files still show the binary-file error. Image decode failures show an
error within the pane.
