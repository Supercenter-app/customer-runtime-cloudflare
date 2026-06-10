import {
  isUsableDeploymentId,
  toResolvedIdentity,
  type RuntimeIdentity,
  type RuntimeIdentityState,
} from "../domain/identity";

export interface RuntimeIdentityStorePort {
  /** Returns the persisted identity, generating one on first call. Atomic. */
  getOrCreate(): Promise<RuntimeIdentity>;
  /** Records the control-plane-assigned deployment id and returns the identity. */
  setDeploymentId(deploymentId: string): Promise<RuntimeIdentity>;
}

export interface RegisterIdentityPort {
  /**
   * Registers an identity with the control plane and returns the assigned
   * deployment id. Implementations must be idempotent for a given install
   * token so concurrent first requests converge on the same deployment.
   */
  register(input: {
    identity: RuntimeIdentity;
    endpointUrl: string;
  }): Promise<{ deploymentId: string }>;
}

export type ExplicitIdentityEnv = {
  deploymentId?: string;
  runtimeInstanceId?: string;
  keyId?: string;
  privateKeyJwk?: JsonWebKey;
  publicKeyJwk?: JsonWebKey;
};

/**
 * Resolves the runtime identity for the current request.
 *
 * Two modes:
 *  - Explicit-key mode (legacy install script): the keypair and ids are
 *    injected as Worker secrets/vars. We trust them verbatim and never
 *    auto-register — the install script drives registration and redeploys with
 *    the assigned deployment id.
 *  - Self-managed mode (Deploy to Cloudflare button): no keypair is provided.
 *    The Worker generates and persists its own identity in the Durable Object
 *    and self-registers on the first request, using the request's own origin as
 *    the endpoint url. The private key never leaves the customer's account.
 */
export async function resolveRuntimeIdentity(deps: {
  explicit?: ExplicitIdentityEnv;
  store?: RuntimeIdentityStorePort;
  registrar?: RegisterIdentityPort;
  installToken?: string;
  endpointUrl?: string;
}): Promise<RuntimeIdentityState> {
  if (deps.explicit?.privateKeyJwk && deps.explicit.runtimeInstanceId) {
    const explicit = deps.explicit;
    return toResolvedIdentity({
      runtimeInstanceId: explicit.runtimeInstanceId!,
      keyId: explicit.keyId ?? explicit.runtimeInstanceId!,
      privateKeyJwk: explicit.privateKeyJwk!,
      publicKeyJwk: explicit.publicKeyJwk ?? explicit.privateKeyJwk!,
      deploymentId: explicit.deploymentId,
    });
  }

  if (!deps.store) {
    throw new Error("A runtime identity store is required when no keypair is provided");
  }

  const identity = await deps.store.getOrCreate();
  if (isUsableDeploymentId(identity.deploymentId)) {
    return toResolvedIdentity(identity);
  }

  // Not yet registered. Self-register only when we can prove our own endpoint
  // and we have an install token to authorize it.
  if (!deps.registrar || !deps.endpointUrl || !deps.installToken) {
    return toResolvedIdentity(identity);
  }

  const { deploymentId } = await deps.registrar.register({
    identity,
    endpointUrl: deps.endpointUrl,
  });
  const updated = await deps.store.setDeploymentId(deploymentId);
  return toResolvedIdentity(updated);
}
