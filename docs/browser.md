# Select menus in streamed browser tabs

Click or tap a native single-choice dropdown in an interactive streamed tab.
Desktop and web show the choices next to the control. The mobile browser and
loopback preview show a choice sheet. Choose an enabled option or dismiss the menu.
The menu closes when the page navigates or the viewer loses control.

The host sends the choices only to the client that clicked. It keeps one offer
per page and accepts an answer only from that client's stream. The offer has at
most 500 options, with labels of at most 150 characters. A removed or disabled
option cannot be applied. A page event tells the viewer when the offer closes.

The relay handles primary clicks and taps in the main document, open shadow
roots, and same-origin frames with untransformed coordinates. The relayed press
runs page handlers with synthetic events. A site that requires trusted events
can ignore them. Keyboard-opened popups, modified desktop clicks, cross-origin
or transformed frames, closed shadow roots, and larger lists use the existing
browser input path.
Multi-select lists and CSS base-select pickers are drawn inside the page.
Local desktop webviews use Chromium's own menus.
