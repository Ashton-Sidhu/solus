# Prompt delivery confirmation

The client can show a session as busy while its provider has no active turn,
including while it waits for another agent's reply. A prompt submitted as a
steer can therefore start a new turn on the host.

The host sends `user_message` to all watching clients, including the sender,
when the prompt has a `clientPromptId`. The client removes the matching pending
prompt and adds the delivered message, preserving its attachments and references.
If the message already exists, confirmation does not add another message or open
another turn. Repeated confirmations have the same effect as one confirmation.

Legacy sends without a prompt id keep the sender exclusion because the client
cannot match their optimistic messages. Queue drains continue to reach all clients.

This contract is shared by Claude and Codex, local IPC and remote connections,
and the desktop, web, and mobile clients in Editor and Pill modes.
