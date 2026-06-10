import { RuntimeProtocolError } from "./protocol";

export type SignedRequestHeaders = {
  requestId: string;
  issuedAt: string;
  expiresAt: string;
  deploymentId: string;
  runtimeInstanceId: string;
  keyId: string;
  contentDigest: string;
  signature: string;
};

export const signedRequestHeaderNames = {
  requestId: "x-supercenter-request-id",
  issuedAt: "x-supercenter-issued-at",
  expiresAt: "x-supercenter-expires-at",
  deploymentId: "x-supercenter-deployment-id",
  runtimeInstanceId: "x-supercenter-runtime-instance-id",
  keyId: "x-supercenter-key-id",
  contentDigest: "x-supercenter-content-digest",
  signature: "x-supercenter-signature",
} as const;

export function readSignedRequestHeaders(headers: Headers): SignedRequestHeaders {
  const signedHeaders = {
    requestId: readHeader(headers, signedRequestHeaderNames.requestId),
    issuedAt: readHeader(headers, signedRequestHeaderNames.issuedAt),
    expiresAt: readHeader(headers, signedRequestHeaderNames.expiresAt),
    deploymentId: readHeader(headers, signedRequestHeaderNames.deploymentId),
    runtimeInstanceId: readHeader(headers, signedRequestHeaderNames.runtimeInstanceId),
    keyId: readHeader(headers, signedRequestHeaderNames.keyId),
    contentDigest: readHeader(headers, signedRequestHeaderNames.contentDigest),
    signature: readHeader(headers, signedRequestHeaderNames.signature),
  };

  if (!signedHeaders.contentDigest.startsWith("sha-256=")) {
    throw new RuntimeProtocolError("signature_invalid", "Unsupported content digest", 401);
  }

  return signedHeaders;
}

export function createCanonicalRequest(input: {
  method: string;
  pathname: string;
  bodyDigest: string;
  headers: Pick<
    SignedRequestHeaders,
    "requestId" | "issuedAt" | "expiresAt" | "deploymentId" | "runtimeInstanceId" | "keyId"
  >;
}): string {
  return [
    input.method.toUpperCase(),
    input.pathname,
    input.bodyDigest,
    input.headers.requestId,
    input.headers.issuedAt,
    input.headers.expiresAt,
    input.headers.deploymentId,
    input.headers.runtimeInstanceId,
    input.headers.keyId,
  ].join("\n");
}

function readHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value) {
    throw new RuntimeProtocolError("signature_required", `Missing ${name}`, 401);
  }
  return value;
}
