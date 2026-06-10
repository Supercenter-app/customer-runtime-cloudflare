export const runtimeProtocolVersion = "2026-06-09";
export const runtimeCapabilities = [
  "register",
  "heartbeat",
  "config-refresh",
  "execute-noop",
  "agent-run:model-v1",
] as const;

export type RuntimeCapability = (typeof runtimeCapabilities)[number];

export type RuntimeHealth = "ok" | "degraded";

export type RuntimeMetadata = {
  deploymentId: string;
  runtimeInstanceId: string;
  runtimeVersion: string;
  protocolVersion: string;
  capabilities: RuntimeCapability[];
};

export type RegisterRuntimeInput = RuntimeMetadata & {
  endpointUrl: string;
  runtimePublicKeyJwk?: JsonWebKey;
};

export type HeartbeatInput = RuntimeMetadata & {
  health: RuntimeHealth;
  configVersion?: string;
  checkedAt: string;
};

export type ConfigRefreshResult = {
  refreshed: boolean;
  configVersion?: string;
  checkedAt: string;
};

export type ExecuteNoopRequest = {
  type: "noop" | "diagnostic";
  runId: string;
  requestId: string;
  deploymentId: string;
  runtimeInstanceId: string;
  issuedAt: string;
  expiresAt: string;
  diagnostic?: {
    message?: string;
  };
};

export type ExecuteAgentRunRequest = {
  type: "agent_run";
  protocolVersion: string;
  runId: string;
  requestId: string;
  orgId: string;
  agentId: string;
  deploymentId: string;
  runtimeInstanceId: string;
  issuedAt: string;
  expiresAt: string;
  fallbackPolicy: "fallback_to_hosted" | "fail_closed";
  execution: {
    mode: "agent-run:v1";
    initialContext?: string;
    prompt: string;
    model?: unknown;
    instructionSource?: unknown;
    additionalPrompt?: string;
  };
};

export type ExecuteRequest = ExecuteNoopRequest | ExecuteAgentRunRequest;

export type ExecuteNoopResult = {
  accepted: true;
  completed: true;
  runId: string;
  requestId: string;
  runtimeInstanceId: string;
  completedAt: string;
  metadata: {
    runtimeVersion: string;
    protocolVersion: string;
  };
};

export type ExecuteAgentRunUnsupportedResult = {
  type: "agent.run.unsupported";
  accepted: false;
  runId: string;
  requestId: string;
  fallbackReason: "runtime_capability_missing";
  message: string;
};

export type ExecuteAgentRunCompletedResult = {
  type: "agent.run.completed";
  requestId: string;
  runId: string;
  success: true;
  output: string;
  modelUsed: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
  responseMessages: unknown[];
};

export type ControlPlaneAgentRunGenerationResult = {
  output: string;
  modelUsed: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
};

/** A tool the model may call, as advertised by the control plane's MCP surface. */
export type ControlPlaneToolDef = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/** A model tool-call request returned by a generate-step. */
export type ControlPlaneToolCall = {
  id: string;
  name: string;
  args: unknown;
};

/** Result of one control-plane model step in a Worker-orchestrated loop. */
export type ControlPlaneStepResult = {
  assistant: {
    content: string;
    toolCalls: ControlPlaneToolCall[];
  };
  finishReason?: string;
  modelUsed?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  };
};

/** Conversation message in the simple wire format shared with generate-step. */
export type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ControlPlaneToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; result: string };

export type ControlPlaneRegistrationResult = {
  registered: boolean;
  deploymentId?: string;
  orgId?: string;
  configVersion?: string;
};

export type ControlPlaneHeartbeatResult = {
  recorded: boolean;
  configVersion?: string;
};

export type RuntimeEvent = {
  type: "diagnostic.completed";
  deploymentId: string;
  runtimeInstanceId: string;
  requestId: string;
  runId: string;
  occurredAt: string;
  metadata: Record<string, string>;
};

export type RuntimeErrorCode =
  | "bad_request"
  | "not_found"
  | "method_not_allowed"
  | "signature_required"
  | "signature_invalid"
  | "request_expired"
  | "replay_detected"
  | "control_plane_error";

export class RuntimeProtocolError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RuntimeProtocolError";
  }
}

export function assertDeploymentTarget(
  input: Pick<ExecuteNoopRequest, "deploymentId" | "runtimeInstanceId">,
  expected: Pick<RuntimeMetadata, "deploymentId" | "runtimeInstanceId">,
): void {
  if (input.deploymentId !== expected.deploymentId) {
    throw new RuntimeProtocolError("signature_invalid", "Deployment mismatch", 403);
  }

  if (input.runtimeInstanceId !== expected.runtimeInstanceId) {
    throw new RuntimeProtocolError("signature_invalid", "Runtime instance mismatch", 403);
  }
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
  if (!isRecord(value)) {
    throw new RuntimeProtocolError("bad_request", "Expected JSON object", 400);
  }

  const type = readString(value, "type");
  if (type === "agent_run") {
    return {
      type,
      protocolVersion: readString(value, "protocolVersion"),
      runId: readString(value, "runId"),
      requestId: readString(value, "requestId"),
      orgId: readString(value, "orgId"),
      agentId: readString(value, "agentId"),
      deploymentId: readString(value, "deploymentId"),
      runtimeInstanceId: readString(value, "runtimeInstanceId"),
      issuedAt: readString(value, "issuedAt"),
      expiresAt: readString(value, "expiresAt"),
      fallbackPolicy:
        value.fallbackPolicy === "fail_closed" ? "fail_closed" : "fallback_to_hosted",
      execution: {
        mode: "agent-run:v1",
        initialContext:
          isRecord(value.execution) && typeof value.execution.initialContext === "string"
            ? value.execution.initialContext
            : undefined,
        prompt:
          isRecord(value.execution) && typeof value.execution.prompt === "string"
            ? value.execution.prompt
            : readString({}, "execution.prompt"),
        model: isRecord(value.execution) ? value.execution.model : undefined,
        instructionSource: isRecord(value.execution)
          ? value.execution.instructionSource
          : undefined,
        additionalPrompt:
          isRecord(value.execution) && typeof value.execution.additionalPrompt === "string"
            ? value.execution.additionalPrompt
            : undefined,
      },
    };
  }
  if (type !== "noop" && type !== "diagnostic") {
    throw new RuntimeProtocolError("bad_request", "Unsupported execution type", 400);
  }

  return {
    type,
    runId: readString(value, "runId"),
    requestId: readString(value, "requestId"),
    deploymentId: readString(value, "deploymentId"),
    runtimeInstanceId: readString(value, "runtimeInstanceId"),
    issuedAt: readString(value, "issuedAt"),
    expiresAt: readString(value, "expiresAt"),
    diagnostic: isRecord(value.diagnostic)
      ? {
          message: typeof value.diagnostic.message === "string" ? value.diagnostic.message : undefined,
        }
      : undefined,
  };
}

export function assertRequestWindow(input: Pick<ExecuteNoopRequest, "issuedAt" | "expiresAt">, now: Date): void {
  const issuedAt = Date.parse(input.issuedAt);
  const expiresAt = Date.parse(input.expiresAt);

  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new RuntimeProtocolError("bad_request", "Invalid request timestamps", 400);
  }

  if (issuedAt > now.getTime() + 60_000 || expiresAt <= now.getTime()) {
    throw new RuntimeProtocolError("request_expired", "Execution request is outside its validity window", 401);
  }
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 60_000) {
    throw new RuntimeProtocolError("bad_request", "Execution request validity window is invalid", 400);
  }
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeProtocolError("bad_request", `Missing ${key}`, 400);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
