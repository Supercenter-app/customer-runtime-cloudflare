import type { ReplayStorePort } from "../application/execute-noop";
import type { RuntimeIdentity } from "../domain/identity";
import type { RuntimeIdentityStorePort } from "../application/bootstrap";

type DurableObjectNamespace = {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
};

type DurableObjectId = unknown;

type DurableObjectStub = {
  fetch(request: Request): Promise<Response>;
};

type DurableObjectState = {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T, options?: { expiration?: number }): Promise<void>;
  };
};

export type ReplayStoreBinding = DurableObjectNamespace | undefined;

/** Durable Object instance name for the singleton runtime-identity record. */
const IDENTITY_OBJECT_NAME = "runtime-identity";
const IDENTITY_STORAGE_KEY = "identity";

export class WorkerReplayStore implements ReplayStorePort {
  constructor(
    private readonly binding: ReplayStoreBinding,
    private readonly namespaceName: string,
  ) {}

  async remember(requestId: string, expiresAt: Date): Promise<"stored" | "replayed"> {
    if (!this.binding) {
      throw new Error("REPLAY_STORE Durable Object binding is required");
    }

    const objectId = this.binding.idFromName(this.namespaceName);
    const response = await this.binding.get(objectId).fetch(
      new Request("https://replay-store.local/remember", {
        method: "POST",
        body: JSON.stringify({ requestId, expiresAt: expiresAt.toISOString() }),
      }),
    );

    if (response.status === 409) {
      return "replayed";
    }

    if (!response.ok) {
      throw new Error(`Replay store failed with ${response.status}`);
    }

    return "stored";
  }
}

/**
 * Persists the Worker's cryptographic identity in its Durable Object so that
 * the private key is generated once, inside the customer's account, and reused
 * across all later requests and re-registrations. Routing identity reads/writes
 * through the single-threaded Durable Object makes get-or-create atomic, so
 * concurrent first requests cannot race into two distinct keypairs.
 */
export class WorkerIdentityStore implements RuntimeIdentityStorePort {
  constructor(private readonly binding: ReplayStoreBinding) {}

  async getOrCreate(): Promise<RuntimeIdentity> {
    return this.callIdentity("/identity/get-or-create");
  }

  async setDeploymentId(deploymentId: string): Promise<RuntimeIdentity> {
    return this.callIdentity("/identity/set-deployment", { deploymentId });
  }

  private async callIdentity(pathname: string, body?: unknown): Promise<RuntimeIdentity> {
    if (!this.binding) {
      throw new Error("REPLAY_STORE Durable Object binding is required for identity storage");
    }
    const objectId = this.binding.idFromName(IDENTITY_OBJECT_NAME);
    const response = await this.binding.get(objectId).fetch(
      new Request(`https://identity-store.local${pathname}`, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    if (!response.ok) {
      throw new Error(`Identity store ${pathname} failed with ${response.status}`);
    }
    return (await response.json()) as RuntimeIdentity;
  }
}

export class ReplayStoreDurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.method === "POST" && pathname === "/identity/get-or-create") {
      return this.getOrCreateIdentity();
    }
    if (request.method === "POST" && pathname === "/identity/set-deployment") {
      return this.setIdentityDeployment(request);
    }
    if (request.method === "POST" && pathname === "/remember") {
      return this.remember(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private async remember(request: Request): Promise<Response> {
    const body = (await request.json()) as { requestId?: unknown; expiresAt?: unknown };
    if (typeof body.requestId !== "string" || typeof body.expiresAt !== "string") {
      return new Response("Bad request", { status: 400 });
    }

    const existing = await this.state.storage.get<{ expiresAt: string }>(body.requestId);
    if (existing) {
      return Response.json({ replayed: true }, { status: 409 });
    }

    const expiration = Math.max(1, Math.floor(Date.parse(body.expiresAt) / 1000));
    await this.state.storage.put(body.requestId, { expiresAt: body.expiresAt }, { expiration });
    return Response.json({ stored: true });
  }

  private async getOrCreateIdentity(): Promise<Response> {
    const existing = await this.state.storage.get<RuntimeIdentity>(IDENTITY_STORAGE_KEY);
    if (existing) {
      return Response.json(existing);
    }
    const identity = await generateRuntimeIdentity();
    await this.state.storage.put(IDENTITY_STORAGE_KEY, identity);
    return Response.json(identity);
  }

  private async setIdentityDeployment(request: Request): Promise<Response> {
    const body = (await request.json()) as { deploymentId?: unknown };
    if (typeof body.deploymentId !== "string" || body.deploymentId.length === 0) {
      return new Response("Bad request", { status: 400 });
    }
    const existing = await this.state.storage.get<RuntimeIdentity>(IDENTITY_STORAGE_KEY);
    if (!existing) {
      return new Response("Identity not initialized", { status: 409 });
    }
    const updated: RuntimeIdentity = { ...existing, deploymentId: body.deploymentId };
    await this.state.storage.put(IDENTITY_STORAGE_KEY, updated);
    return Response.json(updated);
  }
}

async function generateRuntimeIdentity(): Promise<RuntimeIdentity> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const runtimeInstanceId = `cri_${crypto.randomUUID()}`;
  return {
    runtimeInstanceId,
    keyId: runtimeInstanceId,
    privateKeyJwk: normalizeJwk(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    publicKeyJwk: normalizeJwk(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  };
}

function normalizeJwk(jwk: JsonWebKey): JsonWebKey {
  const normalized = { ...jwk };
  delete normalized.alg;
  delete normalized.key_ops;
  return normalized;
}
