# Supercenter Customer Runtime (Cloudflare)

Run your [Supercenter](https://sourcetms.com) agents on **your own Cloudflare
account**. Supercenter keeps the control plane (agent definitions, tool routing,
credentials, orchestration); this Worker only executes the model run. The
Worker's private signing key is generated inside your account and never leaves
it.

## Deploy to Cloudflare (recommended)

1. In Supercenter, go to **Manage → Deployments → New deployment** and copy the
   one-time **install token**.
2. Click the button below. Cloudflare clones this repo into your own GitHub,
   provisions the Durable Object, and prompts you for configuration.
3. When prompted, set `CONTROL_PLANE_URL` (your Supercenter URL) and paste the
   install token as `INSTALL_TOKEN`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Supercenter-app/customer-runtime-cloudflare)

### After deploying

Open your new Worker's URL once (Cloudflare shows a **Visit** link). On that
first request the Worker:

- generates its Ed25519 keypair and persists it in its Durable Object
  (private key stays in your account),
- self-registers with the control plane using the install token,
- discovers the control plane's verification key automatically.

Back in Supercenter the deployment flips to **active**. Point an agent at it via
the agent editor's runtime selector, and runs execute on your Cloudflare Worker.

The install token is single-use and expires in 24 hours; after registration it
is no longer needed.

## CLI install (advanced)

If you'd rather generate the keypair yourself, deploy from a checkout, and
provision in-account run-transcript storage (D1):

```sh
git clone https://github.com/Supercenter-app/customer-runtime-cloudflare
cd customer-runtime-cloudflare
pnpm install            # or npm install
pnpm install-runtime -- --install-token <token> --control-plane-url <url>
```

This generates the keypair as Worker secrets, **provisions and binds a Cloudflare
D1 database** for run transcripts, and registers in one step. Pass `--skip-d1` to
deploy without it. Both flows are interoperable; the Deploy to Cloudflare button
needs no keypair secrets.

## Data residency

In `worker` execution mode the run content (prompts, model messages, tool
args/results) is written to **your own Cloudflare D1** (`RUN_STORE`); the control
plane keeps only metadata and billing.

The one-click button deploys **without** a D1 binding so it always succeeds — in
that case transcripts are returned to the control plane instead. To keep them in
your account, use the CLI install above (it provisions D1) or add a
`d1_databases` binding named `RUN_STORE` to `wrangler.jsonc` and redeploy.

## What the Worker exposes

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | Liveness + the registered deployment id. |
| `POST /v1/register` | Self-registration (install token, first boot only). |
| `POST /v1/runs/execute` | Signed agent-run dispatch from the control plane. |

All `/v1/runs/*` traffic is mutually signed (Ed25519) and replay-protected. The
Worker holds no credentials: tool calls are relayed back to the control plane,
which resolves credentials and runs the tool, then returns only the result.

## License

Proprietary © Supercenter.
