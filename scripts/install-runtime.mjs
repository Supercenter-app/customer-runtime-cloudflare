#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID, webcrypto } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerConfigPath = resolve(packageDir, "wrangler.jsonc");

const options = parseArgs(process.argv.slice(2));
const installToken = requireOption(options.installToken, "--install-token");
const controlPlaneUrl = trimTrailingSlash(
  options.controlPlaneUrl ?? "https://dev.sourcetms.com",
);
const workerName = options.workerName ?? "supercenter-customer-runtime";
const runtimeInstanceId = options.runtimeInstanceId ?? `cri_${randomUUID()}`;
const runtimeVersion = options.runtimeVersion ?? "0.0.0";
const protocolVersion = options.protocolVersion ?? "2026-06-09";

const keys = await generateRuntimeKeys();
const controlPlaneKey = await fetchControlPlaneKey(controlPlaneUrl);
const d1DatabaseName = options.d1DatabaseName ?? workerName;
const d1DatabaseId = options.skipD1 ? undefined : ensureD1DatabaseId(d1DatabaseName);

writeWranglerConfig({
  deploymentId: "install-pending",
  workerName,
  controlPlaneUrl,
  runtimeInstanceId,
  runtimeVersion,
  protocolVersion,
  d1DatabaseName,
  d1DatabaseId,
});

putSecret("INSTALL_TOKEN", installToken);
putSecret("RUNTIME_PRIVATE_KEY_JWK", JSON.stringify(keys.privateJwk));
putSecret("RUNTIME_PUBLIC_KEY_JWK", JSON.stringify(keys.publicJwk));
if (controlPlaneKey?.publicKeyJwk) {
  putSecret("CONTROL_PLANE_PUBLIC_KEY_JWK", JSON.stringify(controlPlaneKey.publicKeyJwk));
}
if (controlPlaneKey?.keyId) {
  putSecret("CONTROL_PLANE_KEY_ID", controlPlaneKey.keyId);
}

const firstDeployOutput = wrangler(["deploy", "--config", wranglerConfigPath], {
  capture: true,
});
const endpointUrl = options.endpointUrl ?? parseWorkersDevUrl(firstDeployOutput);
if (!endpointUrl) {
  throw new Error(
    "Could not determine the workers.dev endpoint. Re-run with --endpoint-url <url>.",
  );
}

const registration = await postJson(new URL("/v1/register", endpointUrl));
if (!registration.registered || typeof registration.deploymentId !== "string") {
  throw new Error(`Runtime registration failed: ${JSON.stringify(registration)}`);
}

writeWranglerConfig({
  deploymentId: registration.deploymentId,
  workerName,
  controlPlaneUrl,
  runtimeInstanceId,
  runtimeVersion,
  protocolVersion,
  d1DatabaseName,
  d1DatabaseId,
});

wrangler(["deploy", "--config", wranglerConfigPath]);
await waitForDeploymentId(endpointUrl, registration.deploymentId);

const [health, heartbeat, configRefresh] = await Promise.all([
  getJson(new URL("/v1/health", endpointUrl)),
  postJson(new URL("/v1/heartbeat", endpointUrl)),
  postJson(new URL("/v1/config/refresh", endpointUrl)),
]);

console.log(
  JSON.stringify(
    {
      endpointUrl,
      deploymentId: registration.deploymentId,
      runtimeInstanceId,
      health,
      heartbeat,
      configRefresh,
    },
    null,
    2,
  ),
);

const BOOLEAN_FLAGS = new Set(["skipD1"]);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const name = rawName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (BOOLEAN_FLAGS.has(name)) {
      parsed[name] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    const value = inlineValue ?? args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}`);
    }
    parsed[name] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return parsed;
}

function requireOption(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

async function generateRuntimeKeys() {
  const pair = await webcrypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  return {
    privateJwk: normalizeJwk(
      await webcrypto.subtle.exportKey("jwk", pair.privateKey),
    ),
    publicJwk: normalizeJwk(
      await webcrypto.subtle.exportKey("jwk", pair.publicKey),
    ),
  };
}

function normalizeJwk(jwk) {
  const normalized = { ...jwk };
  delete normalized.alg;
  delete normalized.key_ops;
  return normalized;
}

async function fetchControlPlaneKey(baseUrl) {
  const response = await fetch(
    new URL("/api/customer-runtimes/control-plane-key", baseUrl),
  );
  if (response.status === 404) {
    console.warn(
      "Control-plane public key is not configured; diagnostics will fail until it is set.",
    );
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Control-plane key discovery failed with ${response.status}: ${await response.text()}`,
    );
  }
  return await response.json();
}

function writeWranglerConfig(input) {
  const config = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: input.workerName,
    main: "src/main.ts",
    compatibility_date: "2026-06-09",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      CONTROL_PLANE_URL: input.controlPlaneUrl,
      DEPLOYMENT_ID: input.deploymentId,
      RUNTIME_INSTANCE_ID: input.runtimeInstanceId,
      RUNTIME_VERSION: input.runtimeVersion,
      PROTOCOL_VERSION: input.protocolVersion,
    },
    triggers: {
      crons: ["*/5 * * * *"],
    },
    durable_objects: {
      bindings: [
        {
          name: "REPLAY_STORE",
          class_name: "ReplayStoreDurableObject",
        },
      ],
    },
    migrations: [
      {
        tag: "v1",
        new_classes: ["ReplayStoreDurableObject"],
      },
    ],
  };
  // Bind the customer's own D1 for in-account run-transcript residency. Omitted
  // only when --skip-d1 is passed, in which case the Worker returns transcripts
  // to the control plane instead (still functional, no data residency).
  if (input.d1DatabaseId) {
    config.d1_databases = [
      {
        binding: "RUN_STORE",
        database_name: input.d1DatabaseName,
        database_id: input.d1DatabaseId,
      },
    ];
  }
  writeFileSync(wranglerConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Provision (or reuse) the customer's D1 database and return its id. Idempotent
 * across re-runs: an existing database is reused rather than recreated.
 */
function ensureD1DatabaseId(databaseName) {
  const existing = readD1DatabaseId(databaseName);
  if (existing) return existing;
  wrangler(["d1", "create", databaseName], { capture: true });
  const created = readD1DatabaseId(databaseName);
  if (!created) {
    throw new Error(
      `Provisioned D1 "${databaseName}" but could not resolve its id. ` +
        "Re-run with --skip-d1 to deploy without in-account transcript storage.",
    );
  }
  return created;
}

function readD1DatabaseId(databaseName) {
  const out = wrangler(["d1", "info", databaseName, "--json"], {
    capture: true,
    allowFailure: true,
  });
  if (!out) return undefined;
  const match = out.match(/"uuid"\s*:\s*"([0-9a-fA-F-]+)"/);
  return match?.[1];
}

function putSecret(name, value) {
  wrangler(["secret", "put", name, "--config", wranglerConfigPath], {
    input: value,
  });
}

function wrangler(args, options = {}) {
  const command = resolveWranglerCommand();
  const result = spawnSync(command.bin, [...command.args, ...args], {
    cwd: packageDir,
    encoding: "utf8",
    input: options.input,
    stdio: options.capture ? ["pipe", "pipe", "pipe"] : ["pipe", "inherit", "inherit"],
  });

  if (result.status !== 0) {
    if (options.allowFailure) return "";
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n");
    throw new Error(`Wrangler failed: ${detail}`);
  }

  if (options.capture) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return `${result.stdout}\n${result.stderr}`;
  }

  return "";
}

function resolveWranglerCommand() {
  const localWrangler = resolve(packageDir, "node_modules/.bin/wrangler");
  if (existsSync(localWrangler)) {
    return { bin: localWrangler, args: [] };
  }
  return { bin: "pnpm", args: ["dlx", "wrangler"] };
}

function parseWorkersDevUrl(output) {
  const match = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i);
  return match?.[0];
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url.pathname} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function postJson(url) {
  const response = await fetch(url, { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url.pathname} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function waitForDeploymentId(endpointUrl, deploymentId) {
  const healthUrl = new URL("/v1/health", endpointUrl);
  const deadline = Date.now() + 60_000;
  let lastHealth;

  while (Date.now() < deadline) {
    try {
      lastHealth = await getJson(healthUrl);
      if (lastHealth.deploymentId === deploymentId) {
        return;
      }
    } catch (error) {
      lastHealth = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new Error(
    `Timed out waiting for Worker deployment ${deploymentId}; last health=${JSON.stringify(lastHealth)}`,
  );
}
