# Mobile images

The native iOS and Android conversation feed follows T3 Code's mobile image layout. Assistant image embeds stay inline in their message. Standalone image and browser screenshot records stay in transcript order. Tool images show inside their open tool details, and as thumbnails in the outputs strip under the row that folds them, so a folded turn still shows them. They are not in the turn's gallery ([Tool outputs](transcript-cards.md#tool-outputs)).

Images keep their original aspect ratio and fit within the available width and a 480-point maximum width and height. Small images are not enlarged. Frames use T3's 10-point corners and image background; the caption is the image's alt text. Loading and failure states use the same renderer.

Tap an image to open the existing full-screen gallery. Images from one message stay together, in document order, without duplicates. Galleries from different messages stay separate. iOS also uses T3's inline pinch and pan gestures; Android opens the full-screen viewer for zoom, as T3 does.

This is a native mobile presentation change requested to align with T3 Code. Desktop and web retain their existing shared carousel. Both providers and local or remote hosts use the same image collection and host media resolver. No server or transport contract changes are needed.

## Video attachments

A video picked from Photos or Files appears as a thumbnail with a play button in the composer. Tap it to preview before sending. The sent message uses T3's inline video player. The phone uses the picked file while the upload is in progress, then gets a signed playback URL from the session's host. Opening the conversation later uses the same player.
