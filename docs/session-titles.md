# Worker session titles

`start_session` starts a worker without a client tab. After the provider issues its session ID, the host generates a short title from the full opening prompt. The worker inherits the lead's execution preferences, including **Automatically name sessions**. If that setting is off, the host keeps the prompt title.

`start_session` takes an optional `title`. When the lead gives one, the host saves it as the session's name and generates no title, also when **Automatically name sessions** is off and also for a session started on another host. The card shows the title from the start. Workers started from one brief all begin with the same sentence, so a lead that starts several workers should give each one a title.

A card shows the session's name first, then the provider's slug, then the first sentence of the prompt.

Generated titles are saved only while the session has no custom title. A name set by a person wins if it arrives during generation. The host announces a saved title to session clients and refreshes linked task attempts. Claude and Codex use the same path.

Opening a task page checks linked attempts in batches of at most 20, two at a time, after the page has read its details. This repairs older workers without a startup scan. The client asks about each session once while it runs. A session that has nothing to name, such as a lead, is not asked again, and a title that the task already shows causes no further read. A worker on another host is named on its execution host; the task host then receives the saved title for its attempt row. An offline host can be checked when the page is opened again. Existing names set by a person are kept.

The repair starts after the updated host and client code load. It does not change stored sessions merely because these files are edited.
