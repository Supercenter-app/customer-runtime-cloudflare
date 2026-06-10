export type ControlPlaneVerificationKey = {
  publicKeyJwk: JsonWebKey;
  keyId: string;
};

/**
 * Discovers the control plane's public signing key so the Worker can verify
 * inbound execution requests. The key is public and the endpoint is
 * unauthenticated, so the Deploy-to-Cloudflare flow can fetch it at runtime
 * instead of asking the customer to paste a JWK as a secret. Results are cached
 * per control-plane origin for the lifetime of the isolate.
 */
const cache = new Map<string, Promise<ControlPlaneVerificationKey | undefined>>();

export async function fetchControlPlaneVerificationKey(
  baseUrl: string,
): Promise<ControlPlaneVerificationKey | undefined> {
  const cached = cache.get(baseUrl);
  if (cached) {
    return cached;
  }
  const pending = load(baseUrl);
  cache.set(baseUrl, pending);
  try {
    return await pending;
  } catch (error) {
    // Don't poison the cache on a transient failure.
    cache.delete(baseUrl);
    throw error;
  }
}

async function load(baseUrl: string): Promise<ControlPlaneVerificationKey | undefined> {
  const response = await fetch(new URL("/api/customer-runtimes/control-plane-key", baseUrl));
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Control-plane key discovery failed with ${response.status}`);
  }
  const data = (await response.json()) as { keyId?: unknown; publicKeyJwk?: unknown };
  if (typeof data.keyId !== "string" || !data.publicKeyJwk || typeof data.publicKeyJwk !== "object") {
    throw new Error("Control-plane key discovery returned an invalid payload");
  }
  return { keyId: data.keyId, publicKeyJwk: data.publicKeyJwk as JsonWebKey };
}
