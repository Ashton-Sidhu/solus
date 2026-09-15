# File previews

The conversation file pane and project Files pane display PNG, JPEG, GIF,
WebP, and SVG files as read-only images. Images fit within the pane on desktop,
web, and mobile. SVG files use an image element, not an executable HTML frame.

The host reads image bytes through `readProjectFile` and returns a data URL.
Remote clients do not need access to the host filesystem. Images have a 10 MB
limit; larger images show an error instead of a partial preview. Unsupported
binary files still show the binary-file error. Image decode failures show an
error within the pane.
