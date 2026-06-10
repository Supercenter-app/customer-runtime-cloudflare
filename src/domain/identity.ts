/**
 * A runtime's cryptographic identity. The private key never leaves the
 * customer's Cloudflare account: it is generated inside the Worker (or its
 * Durable Object) on first boot and persisted there. Only the public key is
 * ever shared with the control plane, during registration.
 */
export type RuntimeIdentity = {
  runtimeInstanceId: string;
  keyId: string;
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
  /** Assigned by the control plane at registration; absent until registered. */
  deploymentId?: string;
};

/** A fully-resolved identity that is ready to serve signed traffic. */
export type ResolvedRuntimeIdentity = RuntimeIdentity & {
  deploymentId: string;
  registered: true;
};

/** An identity that exists locally but has not completed registration yet. */
export type UnregisteredRuntimeIdentity = RuntimeIdentity & {
  registered: false;
};

export type RuntimeIdentityState = ResolvedRuntimeIdentity | UnregisteredRuntimeIdentity;

const PLACEHOLDER_DEPLOYMENT_IDS = new Set(["", "install-pending", "replace-with-deployment-id"]);

/** True when a deployment id is a real, control-plane-assigned identifier. */
export function isUsableDeploymentId(value: string | undefined): value is string {
  return typeof value === "string" && !PLACEHOLDER_DEPLOYMENT_IDS.has(value.trim());
}

export function toResolvedIdentity(identity: RuntimeIdentity): RuntimeIdentityState {
  if (isUsableDeploymentId(identity.deploymentId)) {
    return { ...identity, deploymentId: identity.deploymentId, registered: true };
  }
  return { ...identity, registered: false };
}
