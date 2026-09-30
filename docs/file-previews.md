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

## Media and other binary files

The Files pane shows images, PDFs, and videos on desktop, web, and mobile.
Every client shows the same viewer; none of them depends on Electron.

| Kind | Extensions | Viewer |
|---|---|---|
| Image | PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG | Fitted in the pane. SVG uses an image element, not an executable frame. |
| PDF | PDF | pdf.js: every page, text selection, zoom, fit to width, and find (`mod+F` or `⌥F`). |
| Video | MP4, M4V, MOV, WebM | The shared video player, with seeking. |

HEIC and TIFF are not supported: most browsers cannot show them without
conversion. An iPhone video in HEVC plays only where the browser can decode
HEVC.

`packages/contracts/src/media-types.ts` is the one list of these types. The
host, the file pane, the attachment picker, and the artifact and Markdown image
surfaces all read it. Add a type there, and only there.

`readProjectFile` returns one of three kinds:

- `text` — the contents, for the editor.
- `media` — the media kind and MIME type, but no bytes.
- `binary` — the size only. The pane says that the file type cannot be shown.
  A binary file never opens as text.

A client loads a media file from a short-lived URL the host signs
(`assetCreateUrl`), so a large PDF or video never crosses the RPC channel and
has no size limit. The desktop app uses the same signed URL for its own host as
a remote client does. A signed URL can name a media file anywhere on the host,
not only in the project, so an agent's screenshot in `/tmp` shows in a reply.
It serves only the media types above, never source or secrets. A guest cannot
ask for one.

The file pane handlers (`listProjectFiles`, `readProjectFile`, `writeFile`,
`searchFiles`, and `searchProjectContents`) are in the shared server, so a
standalone host opens and saves files the same way as a desktop host.
