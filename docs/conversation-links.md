# Open a selected conversation link

On desktop, select a complete HTTP or HTTPS URL in a conversation, then open
the existing text context menu and choose **Open link**. Addresses that start
with `www.` use HTTPS. Copy, paste, and quote actions stay in the same menu.
The page opens in the Solus browser on the host that owns the conversation.
This also works for URLs in plain text and code blocks.

Rendered web links also have **Open link** in their existing context menu on
desktop, web, and mobile. With a keyboard, focus the link and use the
context-menu key or Shift+F10. Touch devices use a long press.

The action uses the host browser API. A local address such as
`http://localhost:5173` refers to the conversation's host. Web browsers control
their native text-selection menu; Solus does not replace it.

File links use Pierre file-type icons on desktop, web, and mobile. Filename
rules take priority over file extensions: `AGENTS.md`, `package.json`, and
`tsconfig.json` have specific icons. Other Markdown files, such as
`CONTRIBUTING.md`, use the Markdown icon. Unknown types use a generic file icon.

Web links show the GitHub mark for GitHub pages. Other public websites use
Google’s favicon service, with a globe if the image fails to load. Only the
hostname is sent to Google. Local names and IP addresses use the globe without
a favicon request. This applies to desktop, web, and mobile.

The shared rules and SVG symbols live in `packages/client-core/src/file-icons.ts`.
The composer, file browser, search, diff, review, attachments, and conversation
links use this owner. Native Markdown uses PNG assets generated from these SVGs;
after changing a symbol, run `bun run generate:file-icons`.

File icons keep Pierre's file-type colors in light and dark mode. Link text
keeps its link color. The shared icon module owns both color palettes.
