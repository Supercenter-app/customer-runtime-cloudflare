import { createCanonicalRequest, readSignedRequestHeaders, type SignedRequestHeaders } from "../domain/signing";
import { RuntimeProtocolError } from "../domain/protocol";

export interface SignatureVerifier {
  verifyRequest(request: Request, bodyText: string): Promise<SignedRequestHeaders>;
}

export interface RuntimeRequestSigner {
  signJson(method: string, pathname: string, bodyText: string): Promise<HeadersInit>;
}

export class WebCryptoSignatureVerifier implements SignatureVerifier {
  constructor(
    private readonly controlPlanePublicKeyJwk: JsonWebKey | undefined,
    private readonly controlPlaneKeyId: string | undefined,
  ) {}

  async verifyRequest(request: Request, bodyText: string): Promise<SignedRequestHeaders> {
    if (!this.controlPlanePublicKeyJwk) {
      throw new RuntimeProtocolError("signature_required", "Control plane public key is not configured", 401);
    }

    const signedHeaders = readSignedRequestHeaders(request.headers);
    if (!this.controlPlaneKeyId || signedHeaders.keyId !== this.controlPlaneKeyId) {
      throw new RuntimeProtocolError("signature_invalid", "Unknown control plane key id", 401);
    }
    assertSignedRequestWindow(signedHeaders.issuedAt, signedHeaders.expiresAt, new Date(), 60_000);
    const bodyDigest = await sha256DigestHeader(bodyText);
    if (signedHeaders.contentDigest !== bodyDigest) {
      throw new RuntimeProtocolError("signature_invalid", "Content digest mismatch", 401);
    }

    const canonical = createCanonicalRequest({
      method: request.method,
      pathname: new URL(request.url).pathname,
      bodyDigest,
      headers: signedHeaders,
    });

    const key = await importEd25519Key(this.controlPlanePublicKeyJwk, ["verify"]);
    const verified = await crypto.subtle.verify(
      "Ed25519",
      key,
      base64UrlToBytes(signedHeaders.signature),
      new TextEncoder().encode(canonical),
    );

    if (!verified) {
      throw new RuntimeProtocolError("signature_invalid", "Invalid request signature", 401);
    }

    return signedHeaders;
  }
}

function assertSignedRequestWindow(
  issuedAt: string,
  expiresAt: string,
  now: Date,
  maxTtlMs: number,
): void {
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new RuntimeProtocolError("signature_invalid", "Invalid signature timestamps", 401);
  }
  if (issuedAtMs > now.getTime() + 60_000 || expiresAtMs <= now.getTime()) {
    throw new RuntimeProtocolError("request_expired", "Signed request is outside its validity window", 401);
  }
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > maxTtlMs) {
    throw new RuntimeProtocolError("signature_invalid", "Signed request window is invalid", 401);
  }
}

export class WebCryptoRuntimeRequestSigner implements RuntimeRequestSigner {
  constructor(
    private readonly runtimePrivateKeyJwk: JsonWebKey | undefined,
    private readonly identity: {
      deploymentId: string;
      runtimeInstanceId: string;
      keyId: string;
    },
  ) {}

  async signJson(method: string, pathname: string, bodyText: string): Promise<HeadersInit> {
    const headers = new Headers({
      "content-type": "application/json",
    });

    if (!this.runtimePrivateKeyJwk) {
      return headers;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const requestId = crypto.randomUUID();
    const bodyDigest = await sha256DigestHeader(bodyText);
    const canonical = createCanonicalRequest({
      method,
      pathname,
      bodyDigest,
      headers: {
        requestId,
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        deploymentId: this.identity.deploymentId,
        runtimeInstanceId: this.identity.runtimeInstanceId,
        keyId: this.identity.keyId,
      },
    });

    const key = await importEd25519Key(this.runtimePrivateKeyJwk, ["sign"]);
    const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(canonical));

    headers.set("x-supercenter-request-id", requestId);
    headers.set("x-supercenter-issued-at", now.toISOString());
    headers.set("x-supercenter-expires-at", expiresAt.toISOString());
    headers.set("x-supercenter-deployment-id", this.identity.deploymentId);
    headers.set("x-supercenter-runtime-instance-id", this.identity.runtimeInstanceId);
    headers.set("x-supercenter-key-id", this.identity.keyId);
    headers.set("x-supercenter-content-digest", bodyDigest);
    headers.set("x-supercenter-signature", bytesToBase64Url(new Uint8Array(signature)));

    return headers;
  }
}

export async function sha256DigestHeader(bodyText: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText));
  return `sha-256=${bytesToBase64Url(new Uint8Array(digest))}`;
}

async function importEd25519Key(jwk: JsonWebKey, keyUsages: KeyUsage[]): Promise<CryptoKey> {
  const normalizedJwk = { ...jwk };
  delete normalizedJwk.alg;
  delete normalizedJwk.key_ops;
  return crypto.subtle.importKey("jwk", normalizedJwk, "Ed25519", false, keyUsages);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): ArrayBuffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
