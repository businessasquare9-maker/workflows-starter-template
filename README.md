# Alex Pizza AI Voice Agent

Cloudflare Worker backend for the Alex Pizza inbound voice agent. The worker exposes health, Vapi tool, admin, order, booking, notification, and optional Zoho POS push routes.

## Deploy

1. Keep the existing D1 database. In `wrangler.jsonc`, replace both `REPLACE_WITH_YOUR_EXISTING_D1_DATABASE_NAME` and `REPLACE_WITH_YOUR_EXISTING_D1_DATABASE_ID` with that database's exact name and ID. Do not create a new database if you need to preserve existing data.
2. Install dependencies with `npm install`.
3. Set the Worker secrets/variables listed below in Cloudflare Dashboard (Workers & Pages → alex-pizza-voice-agent → Settings → Variables and Secrets), or via Wrangler secrets.
4. Run `npm run check`, then `npm run deploy`.

## Required Cloudflare binding

- D1 binding name: `DB` (must point to your existing D1 database).

## Secrets and variables

Configure only values applicable to your setup. Never commit secret values into GitHub.

- `TOOL_SHARED_SECRET` (or `VAPI_TOOL_SECRET` / `AGENT_TOOL_SECRET`) — shared secret used by Vapi tool calls.
- `ADMIN_API_TOKEN` (or `ADMIN_SECRET` / `WORKER_ADMIN_TOKEN`) — protects admin endpoints.
- `ZOHO_CLIENT_ID`
- `ZOHO_CLIENT_SECRET`
- `ZOHO_REFRESH_TOKEN`
- `ZOHO_POS_ORDER_URL` or `ZOHO_ORDER_WEBHOOK_URL` — required only if order push is intended. This must be a real HTTPS endpoint that accepts the JSON payload this worker sends; it is not the Zoho OAuth redirect URI.
- Optional: `ZOHO_TOKEN_URL` / `ZOHO_ACCOUNTS_TOKEN_URL` for the correct Zoho data centre, `ZOHO_TENANT_ID`, `NOTIFICATION_WEBHOOK_URL`, and the applicable phone/business variables.

## Routes

- `GET /` and `GET /health` — non-sensitive health/configuration status.
- `POST /vapi/:tenant/tools` — authenticated Vapi tool calls.
- `GET /vapi/:tenant/tools` — authenticated tool catalog.
- `POST /admin/bootstrap`, `/admin/sync-menu`, `/admin/purge-60-days`, `/admin/zoho-token` — authenticated admin routes.

Admin routes require `x-admin-key`, `x-admin-token`, `x-admin-secret`, or a Bearer token. Vapi tool routes require `x-agent-tool-secret`, `x-tool-secret`, `x-vapi-secret`, or a Bearer token.

## Zoho health fields

The health response separates `zoho_oauth_configured` from `zoho_pos_endpoint_configured`. `zoho_pos_configured` is true only when OAuth credentials, the POS endpoint, and D1 are configured. OAuth credentials alone do not supply a POS order endpoint. A successful health check does not prove that the external endpoint accepts orders; test `/admin/zoho-token` first, then test a safe order only when the endpoint is verified.

## Important

- `/admin/sync-menu` replaces the tenant's D1 menu with the hard-coded menu in this source. It does **not** fetch menu items from Zoho POS.
- Do not expose admin tokens, Vapi shared secrets, or Zoho tokens in browser code, logs, or Git.
- The daily scheduled trigger runs the configured 60-day data purge.
