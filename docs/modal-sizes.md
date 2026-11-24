# Modal sizes

The user can resize the large modals on desktop and web:

- the session picker
- Settings
- the folder picker
- search in files

## How to resize

- Drag the right edge, the bottom edge, or the bottom-right corner.
- A centred modal grows on the two sides, so the edge stays under the pointer. Search in files is pinned near the top of the window, so it grows downward only.
- Keyboard: the corner is a focusable separator. The arrow keys change the size in 16px steps; with Shift, in 64px steps. Home goes back to the default size.
- A double-click on a handle goes back to the default size.

## Limits

- A modal is never smaller than 320 × 240 px.
- A modal always keeps 16px between itself and the window edge. If the window becomes smaller, the modal becomes smaller with it.

## Where the size is kept

Each kind of modal keeps its own size on this device, in local storage (`solus.modal-size.<kind>`). The size is not synced to the account or to other devices. The loading skeleton of the session picker uses the saved size, so the picker does not jump when it loads.

## Where resize does not apply

- Small forms and confirm dialogs (rename, share, add host, and similar) keep a fixed size.
- Quick launchers (the command palette and go to file) keep a fixed size.
- Documents and plans open in a pane, not in a modal. To change their size, resize the pane.
- A touch screen (`pointer: coarse`) shows no handles.
- The mobile app uses native sheets, not modals, so it has no resize control.

The code is in `packages/workspace-ui/src/components/ui/modal-resize/`. To make a modal resizable, give its card `relative` (or `fixed`), set `style={resizable.style}` on it, and put `<ModalResizeHandles>` as the last child of the card.
