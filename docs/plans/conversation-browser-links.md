# Conversation browser links

Web links in messages open in the device's default browser when clicked.
Right-click a link and select **Open in Solus** to open the page beside the
conversation. The link menu also offers **Open in default browser** and
**Copy Link**. There is no extra inline control or hover action.

Use a long press on touch screens. With a keyboard, focus the link and press
Shift+F10 or the context-menu key. Arrow keys select an action; Enter runs it.
Escape closes the menu and returns focus to the link.

The shared message renderer provides this behavior on desktop, web, and mobile,
for both agent providers. Opening from Pill mode shows the Editor workspace.
The page opens on the session's host, so a remote session's local web addresses
resolve on that host. Files, sessions, works, plans, and other links with a Solus
destination keep their existing routes. Open failures show an error toast.

The link menu uses the shared context-menu primitives and portals outside the
message's paint containment, with viewport collision handling.
