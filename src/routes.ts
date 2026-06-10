import { executeNoop, type ReplayStorePort, type RuntimeEventPort } from "./application/execute-noop";
import { executeAgentRun, type RunStorePort } from "./application/execute-agent-run";
import { refreshConfig, sendHeartbeat } from "./application/heartbeat";
import { registerRuntime } from "./application/register";
import {
  parseExecuteRequest,
  runtimeCapabilities,
  RuntimeProtocolError,
  type RuntimeMetadata,
} from "./domain/protocol";
import type { SignedRequestHeaders } from "./domain/signing";
import type { SignatureVerifier } from "./adapters/signing";
import type { ControlPlaneClient } from "./adapters/control-plane-client";

export type RouteContext = {
  request: Request;
  runtime: RuntimeMetadata;
  controlPlane: ControlPlaneClient;
  runtimePublicKeyJwk?: JsonWebKey;
  replayStore: ReplayStorePort;
  runStore?: RunStorePort;
  events: RuntimeEventPort;
  signatureVerifier: SignatureVerifier;
  now: () => Date;
};

export type RouteDefinition = {
  method: string;
  pathname: string;
  handler: (context: RouteContext) => Promise<Response>;
};

export const routes: RouteDefinition[] = [
  {
    method: "GET",
    pathname: "/v1/health",
    handler: async ({ runtime }) =>
      json({
        ok: true,
        deploymentId: runtime.deploymentId,
        runtimeInstanceId: runtime.runtimeInstanceId,
      }),
  },
  {
    method: "GET",
    pathname: "/v1/version",
    handler: async ({ runtime }) =>
      json({
        runtimeVersion: runtime.runtimeVersion,
        protocolVersion: runtime.protocolVersion,
        capabilities: runtimeCapabilities,
      }),
  },
  {
    method: "POST",
    pathname: "/v1/register",
    handler: async ({ request, runtime, controlPlane, runtimePublicKeyJwk }) => {
      const result = await registerRuntime(controlPlane, {
        ...runtime,
        endpointUrl: new URL(request.url).origin,
        runtimePublicKeyJwk,
      });
      return json(result);
    },
  },
  {
    method: "POST",
    pathname: "/v1/heartbeat",
    handler: async ({ runtime, controlPlane, now }) => {
      const result = await sendHeartbeat(controlPlane, { ...runtime, now: now() });
      return json(result);
    },
  },
  {
    method: "POST",
    pathname: "/v1/config/refresh",
    handler: async ({ runtime, controlPlane, now }) => {
      const result = await refreshConfig(controlPlane, runtime);
      return json({
        refreshed: true,
        configVersion: result.configVersion,
        checkedAt: now().toISOString(),
      });
    },
  },
  {
    method: "POST",
    pathname: "/v1/runs/execute",
    handler: async ({ request, runtime, replayStore, runStore, events, signatureVerifier, controlPlane, now }) => {
      const bodyText = await request.text();
      const signedHeaders = await signatureVerifier.verifyRequest(request, bodyText);
      const executionRequest = parseExecuteRequest(JSON.parse(bodyText) as unknown);
      assertSignedBodyMatchesHeaders(executionRequest, signedHeaders);
      if (executionRequest.type === "agent_run") {
        const result = await executeAgentRun({
          request: executionRequest,
          runtime,
          replayStore,
          runStore,
          controlPlane,
          now: now(),
        });
        return json(result);
      }
      const result = await executeNoop({
        request: executionRequest,
        runtime,
        replayStore,
        events,
        now: now(),
      });
      return json(result);
    },
  },
];

export async function routeRequest(context: RouteContext): Promise<Response> {
  const url = new URL(context.request.url);
  const route = routes.find((candidate) => candidate.method === context.request.method && candidate.pathname === url.pathname);

  if (!route) {
    const pathExists = routes.some((candidate) => candidate.pathname === url.pathname);
    if (pathExists) {
      return jsonError(new RuntimeProtocolError("method_not_allowed", "Method not allowed", 405));
    }
    return jsonError(new RuntimeProtocolError("not_found", "Not found", 404));
  }

  try {
    return await route.handler(context);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return jsonError(new RuntimeProtocolError("bad_request", `Invalid JSON body: ${error.message}`, 400));
    }
    if (error instanceof RuntimeProtocolError) {
      return jsonError(error);
    }
    return jsonError(
      new RuntimeProtocolError(
        "control_plane_error",
        error instanceof Error ? error.message : "Runtime request failed",
        500,
      ),
    );
  }
}

function assertSignedBodyMatchesHeaders(
  body: {
    requestId: string;
    issuedAt: string;
    expiresAt: string;
    deploymentId: string;
    runtimeInstanceId: string;
  },
  headers: SignedRequestHeaders,
): void {
  if (
    body.requestId !== headers.requestId ||
    body.issuedAt !== headers.issuedAt ||
    body.expiresAt !== headers.expiresAt ||
    body.deploymentId !== headers.deploymentId ||
    body.runtimeInstanceId !== headers.runtimeInstanceId
  ) {
    throw new RuntimeProtocolError("signature_invalid", "Signed headers do not match request body", 401);
  }
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init);
}

function jsonError(error: RuntimeProtocolError): Response {
  return json(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    { status: error.status },
  );
}
