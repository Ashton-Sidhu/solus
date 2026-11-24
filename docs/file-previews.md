# File previews

Image and video chips in assistant messages open a media dialog on desktop
and web. Close the dialog with its close button or Escape. Mobile opens its
native media preview. Other file-name chips open the Files pane with the file
selected and any linked line revealed. Text files inside
the session's project or worktree support editing and autosave on desktop,
web, and mobile. Files outside that directory and text previews truncated at
1 MiB are read-only. For HTML files, select Source to edit the markup.

On desktop and web, open an image from a turn's carousel to browse its images
in the media dialog. Use the side arrows or the Left and Right arrow keys.
The header shows the image position. Navigation stops at the first and last
image. A single image has no navigation arrows. Mobile supports swiping
between images in its native gallery.

For Markdown files, select Editor or Markdown in the outlined control in the
pane header. Editor opens the rich-text editor; Markdown opens the source.

A Markdown file can become a work. Select **Save as work** in the file pane
header, in the file's header in the diff pane, or from the command palette while
a files pane shows the file. Solus copies the text into a new doc work on the
host that holds the file and opens it. The title is the file's first top-level
heading, else its file name. The work is a copy, not a mirror: later edits to
the file do not reach the work, and edits to the work do not reach the file.
The selected view is remembered on each desktop, web, or mobile client.

File view controls and Settings use the same shared segmented control: an
outlined track with a raised selection. Each segment fits its label with
equal horizontal padding. File headers use the compact size: 24 px high
with lighter labels and less padding. Touch controls retain their larger
height.

## Open files in another application

Use the file tree menu or **File actions** in a diff header. For files on the
desktop client's own host, **Open** uses the system default application,
**Reveal in file manager** selects the path, and **Open with** lists installed
editors. These actions require permission to use the host and read its files.
Local desktop actions also require permission to open native windows.

For a remote SSH host, **Open with** hands the file or folder to an editor on
the viewing computer. Solus uses the SSH alias saved on that computer when
available, or the SSH address the host advertises. Set any custom port, key,
or jump host for the alias in the viewing computer's SSH config.

On the macOS, Windows, and Linux desktop app, **Open local copy** and **Reveal
local copy** download a single remote file to a private temporary folder on
the viewing computer. Edits to the copy stay local. Save it elsewhere if you
need to keep it. Solus removes it after ten minutes or when it quits. The
transfer limit is 10 MiB. Open supports common text, source, image, media,
and PDF file types. Reveal adds a `.txt` suffix to copies of executables and
other file types that Solus cannot open safely.

Desktop web browsers can hand off an advertised SSH address to VS Code. The
native mobile app and mobile browsers use the in-app file preview.

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

A HEIC photo attached to a prompt is different. A macOS host converts it to a
JPEG with `sips` when the photo arrives, so the composer and the transcript show
it and the agent reads it as an image. The original file on disk does not
change. A host that cannot convert it (Linux or Windows) keeps the HEIC as a
file attachment, never as a broken image. The mobile app converts a photo to
JPEG before it uploads.

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
