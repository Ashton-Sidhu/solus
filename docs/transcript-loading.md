# Opening a conversation

The conversation pane keeps its size while messages load. An uncached
conversation shows a blank reading area, with a small loading status if the
request takes longer. It does not show placeholder message rows.

Desktop and web keep the real rows transparent until the view has restored
the saved reading position, or reached the end on a first open. Hiding or
closing the view cancels that positioning operation. Loading history again
does not hide messages that are already available.

Mobile keeps its native list transparent until the list reports that its
initial layout and scroll position are ready. Existing rows remain visible
while the conversation reconnects.

Session opening and startup restoration own the history request. The mounted
conversation view owns when its rows can be shown. Paint timing starts only
after those rows are visible. Older pages and embedded content can load later;
the list preserves the reading position as their sizes change.
