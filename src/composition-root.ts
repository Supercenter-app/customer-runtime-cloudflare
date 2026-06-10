import { ControlPlaneClient } from "./adapters/control-plane-client";
import { fetchControlPlaneVerificationKey } from "./adapters/control-plane-key";
import { WorkerReplayStore, WorkerIdentityStore, type ReplayStoreBinding } from "./adapters/replay-store";
import { WorkerRunStore, type RunStoreBinding } from "./adapters/run-store";
import { WebCryptoRuntimeRequestSigner, WebCryptoSignatureVerifier } from "./adapters/signing";
import {
  resolveRuntimeIdentity,
  type ExplicitIdentityEnv,
  type RegisterIdentityPort,
} from "./application/bootstrap";
import type { RuntimeIdentityState } from "./domain/identity";
import { runtimeCapabilities, runtimeProtocolVersion, type RuntimeMetadata } from "./domain/protocol";
import { routeRequest } from "./routes";

export type CustomerRuntimeEnv = {
  CONTROL_PLANE_URL: string;
  INSTALL_TOKEN?: string;
  DEPLOYMENT_ID?: string;
  RUNTIME_INSTANCE_ID?: string;
  RUNTIME_VERSION?: string;
  PROTOCOL_VERSION?: string;
  RUNTIME_PRIVATE_KEY_JWK?: string;
  RUNTIME_PUBLIC_KEY_JWK?: string;
  CONTROL_PLANE_PUBLIC_KEY_JWK?: string;
  CONTROL_PLANE_KEY_ID?: string;
  RUNTIME_KEY_ID?: string;
  REPLAY_STORE?: ReplayStoreBinding;
  RUN_STORE?: RunStoreBinding;
};

export function createRuntimeApp(env: CustomerRuntimeEnv): {
  fetch(request: Request): Promise<Response>;
  scheduled(): Promise<void>;
} {
  const identityStore = new WorkerIdentityStore(env.REPLAY_STORE);

  return {
    async fetch(request: Request) {
      const identity = await resolveIdentity(env, identityStore, new URL(request.url).origin);
      return routeRequest(await buildRouteContext(env, identity, request));
    },
    async scheduled() {
      // Cron has no inbound origin, so it cannot self-register. Heartbeat only
      // once the Worker has registered via a prior HTTP request.
      const identity = await resolveIdentity(env, identityStore, undefined);
      if (!identity.registered) {
        return;
      }
      const { controlPlane, runtime } = buildRuntimeBindings(env, identity);
      await controlPlane.sendHeartbeat({
        ...runtime,
        health: "ok",
        checkedAt: new Date().toISOString(),
      });
    },
  };
}

async function resolveIdentity(
  env: CustomerRuntimeEnv,
  identityStore: WorkerIdentityStore,
  endpointUrl: string | undefined,
): Promise<RuntimeIdentityState> {
  return resolveRuntimeIdentity({
    explicit: explicitIdentityFromEnv(env),
    store: identityStore,
    registrar: createRegistrar(env),
    installToken: env.INSTALL_TOKEN,
    endpointUrl,
  });
}

function explicitIdentityFromEnv(env: CustomerRuntimeEnv): ExplicitIdentityEnv {
  return {
    deploymentId: env.DEPLOYMENT_ID,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    keyId: env.RUNTIME_KEY_ID ?? env.RUNTIME_INSTANCE_ID,
    privateKeyJwk: parseOptionalJwk(env.RUNTIME_PRIVATE_KEY_JWK, "RUNTIME_PRIVATE_KEY_JWK"),
    publicKeyJwk: parseOptionalJwk(env.RUNTIME_PUBLIC_KEY_JWK, "RUNTIME_PUBLIC_KEY_JWK"),
  };
}

function createRegistrar(env: CustomerRuntimeEnv): RegisterIdentityPort {
  return {
    async register({ identity, endpointUrl }) {
      const signer = new WebCryptoRuntimeRequestSigner(identity.privateKeyJwk, {
        deploymentId: identity.deploymentId ?? "install-pending",
        runtimeInstanceId: identity.runtimeInstanceId,
        keyId: identity.keyId,
      });
      const controlPlane = new ControlPlaneClient({
        baseUrl: requireEnv(env.CONTROL_PLANE_URL, "CONTROL_PLANE_URL"),
        installToken: env.INSTALL_TOKEN,
        signer,
      });
      const result = await controlPlane.registerRuntime({
        deploymentId: identity.deploymentId ?? "install-pending",
        runtimeInstanceId: identity.runtimeInstanceId,
        runtimeVersion: env.RUNTIME_VERSION ?? "0.0.0",
        protocolVersion: env.PROTOCOL_VERSION ?? runtimeProtocolVersion,
        capabilities: [...runtimeCapabilities],
        endpointUrl,
        runtimePublicKeyJwk: identity.publicKeyJwk,
      });
      if (!result.registered || typeof result.deploymentId !== "string") {
        throw new Error("Control plane did not return a deployment id during registration");
      }
      return { deploymentId: result.deploymentId };
    },
  };
}

async function buildRouteContext(env: CustomerRuntimeEnv, identity: RuntimeIdentityState, request: Request) {
  const { controlPlane, replayStore, runtime } = buildRuntimeBindings(env, identity);
  const verification = await resolveControlPlaneVerification(env);
  return {
    request,
    runtime,
    runtimePublicKeyJwk: identity.publicKeyJwk,
    controlPlane,
    replayStore,
    runStore: new WorkerRunStore(env.RUN_STORE),
    events: controlPlane,
    signatureVerifier: new WebCryptoSignatureVerifier(verification.publicKeyJwk, verification.keyId),
    now: () => new Date(),
  };
}

/**
 * Resolves the control plane's verification key. Explicit secrets win (legacy
 * install script); otherwise the key is discovered from the control plane so
 * the Deploy-to-Cloudflare flow needs no JWK secret pasted by the customer.
 */
async function resolveControlPlaneVerification(
  env: CustomerRuntimeEnv,
): Promise<{ publicKeyJwk: JsonWebKey | undefined; keyId: string | undefined }> {
  const explicitJwk = parseOptionalJwk(env.CONTROL_PLANE_PUBLIC_KEY_JWK, "CONTROL_PLANE_PUBLIC_KEY_JWK");
  if (explicitJwk && env.CONTROL_PLANE_KEY_ID) {
    return { publicKeyJwk: explicitJwk, keyId: env.CONTROL_PLANE_KEY_ID };
  }
  try {
    const discovered = await fetchControlPlaneVerificationKey(
      requireEnv(env.CONTROL_PLANE_URL, "CONTROL_PLANE_URL"),
    );
    if (discovered) {
      return { publicKeyJwk: discovered.publicKeyJwk, keyId: discovered.keyId };
    }
  } catch {
    // Fall through: the verifier will reject inbound signed requests until the
    // control-plane key becomes available, which is the correct fail-closed.
  }
  return { publicKeyJwk: explicitJwk, keyId: env.CONTROL_PLANE_KEY_ID };
}

function buildRuntimeBindings(env: CustomerRuntimeEnv, identity: RuntimeIdentityState) {
  const runtime = buildRuntimeMetadata(env, identity);
  const signer = new WebCryptoRuntimeRequestSigner(identity.privateKeyJwk, {
    deploymentId: runtime.deploymentId,
    runtimeInstanceId: runtime.runtimeInstanceId,
    keyId: identity.keyId,
  });
  const controlPlane = new ControlPlaneClient({
    baseUrl: requireEnv(env.CONTROL_PLANE_URL, "CONTROL_PLANE_URL"),
    installToken: env.INSTALL_TOKEN,
    signer,
  });
  const replayStore = new WorkerReplayStore(env.REPLAY_STORE, runtime.deploymentId);
  return { runtime, signer, controlPlane, replayStore };
}

function buildRuntimeMetadata(env: CustomerRuntimeEnv, identity: RuntimeIdentityState): RuntimeMetadata {
  return {
    deploymentId: identity.registered ? identity.deploymentId : env.DEPLOYMENT_ID ?? "install-pending",
    runtimeInstanceId: identity.runtimeInstanceId,
    runtimeVersion: env.RUNTIME_VERSION ?? "0.0.0",
    protocolVersion: env.PROTOCOL_VERSION ?? runtimeProtocolVersion,
    capabilities: [...runtimeCapabilities],
  };
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function parseOptionalJwk(value: string | undefined, name: string): JsonWebKey | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as JsonWebKey;
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}
