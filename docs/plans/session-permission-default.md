# Default permission mode

General settings has a Default permission mode control: Ask, Auto, or Plan.
The connected settings host saves this app preference and shares it with desktop,
web, and mobile clients. As with the default model, the client passes this mode
explicitly when starting a run on another host; the destination does not replace it.
Auto remains the default for existing installations.

New interactive session composers use the saved mode. An explicit choice in an
open draft or an existing session remains unchanged when the saved default changes.
Resumed sessions retain their own run configuration. Automations, peer-created
background sessions, and prepared PR workflows retain their explicit modes.

The setting uses the existing host-config RPC and update events. Agents can read
the default but cannot change it through update_config, since it controls permission
checks for future user sessions.
