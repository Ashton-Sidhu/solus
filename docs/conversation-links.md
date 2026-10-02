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
