# Local Grafana for Solus development

From the repository root, with Docker running:

```sh
docker compose -f scripts/dev-observability/compose.yaml up -d
```

Open http://127.0.0.1:3000/d/solus-dev-logs. The dashboard is available without a login on this machine. To edit dashboards or use Explore, sign in with the local development credentials `admin` / `admin` (Grafana may ask you to change the password). Only loopback ports 3000 and 4318 are published.

In Solus Settings → Telemetry, save `http://127.0.0.1:4318` as the collector endpoint, clear collector headers, and enable telemetry, traces and logs, and metrics. Environment variables take precedence if this form is disabled. The address is relative to the Solus host: it works when Solus and Docker run on the same machine. Metrics export every 30 seconds; traces arrive after spans end.

The stack uses the official Grafana development image and Alloy, pinned by image digest. Alloy reads `dev.log` and `dev-console.log` from a read-only repository directory mount. Mounting the directory allows it to follow files across app restarts. Its offsets and the backend data use separate Docker volumes. This does not modify the Solus logs or database.

## Reading the dashboard

- App activity refreshes every five seconds. Search by text or a session ID. Rows show RPC method, operation, path, timing, session ID, and error text when present. Expand a row for all parsed fields, including RPC arguments.
- Streaming diagnostics defaults to Hidden. It hides DEBUG events named `raw_provider_event`, `session_event_bytes`, and `host_event_published`. This includes raw provider payloads and transport diagnostics for both Claude and Codex. It is a display filter; select Visible to restore them.
- Warnings and errors remain visible, including events with those same names at warning or error severity.
- The collapsed Raw console / build output row contains unfiltered terminal output, including build errors, stack traces, and streaming diagnostics.
- In Explore, choose Tempo for traces or Prometheus for metrics. Log trace IDs are stored as structured metadata, not high-cardinality stream labels.

## Stop and resume

```sh
docker compose -f scripts/dev-observability/compose.yaml stop
docker compose -f scripts/dev-observability/compose.yaml start
```

Disable telemetry in Solus if you stop the collector for an extended time. Containers have no automatic restart policy. Docker must be running to start them again. `docker compose ... down` removes the containers but preserves the named volumes; do not add `--volumes` unless you want to delete collected history.

This is a local development stack. It is not configured as a remotely accessible monitoring service. No Solus application code or client capability changes are required.
