import type { HeartbeatControlPlanePort } from "../application/heartbeat";
import type { RegisterControlPlanePort } from "../application/register";
import type {
  ControlPlaneHeartbeatResult,
  ControlPlaneRegistrationResult,
  HeartbeatInput,
  RegisterRuntimeInput,
  RuntimeEvent,
  RuntimeMetadata,
  ExecuteAgentRunRequest,
  ControlPlaneAgentRunGenerationResult,
  ControlPlaneToolDef,
  ControlPlaneStepResult,
  WireMessage,
} from "../domain/protocol";
import { RuntimeProtocolError } from "../domain/protocol";
import type { RuntimeEventPort } from "../application/execute-noop";
import type { RuntimeRequestSigner } from "./signing";

export class ControlPlaneClient implements RegisterControlPlanePort, HeartbeatControlPlanePort, RuntimeEventPort {
  constructor(
    private readonly input: {
      baseUrl: string;
      installToken?: string;
      signer: RuntimeRequestSigner;
    },
  ) {}

  async registerRuntime(input: RegisterRuntimeInput): Promise<ControlPlaneRegistrationResult> {
    return this.postJson<ControlPlaneRegistrationResult>("/api/customer-runtimes/register", input, true);
  }

  async sendHeartbeat(input: HeartbeatInput): Promise<ControlPlaneHeartbeatResult> {
    return this.postJson<ControlPlaneHeartbeatResult>("/api/customer-runtimes/heartbeat", input, true);
  }

  async refreshConfig(input: RuntimeMetadata): Promise<{ configVersion?: string }> {
    return this.postJson<{ configVersion?: string }>("/api/customer-runtimes/config/refresh", input, true);
  }

  async recordEvent(event: RuntimeEvent): Promise<void> {
    await this.postJson<unknown>("/api/customer-runtimes/events", event, false);
  }

  async generateAgentRun(input: ExecuteAgentRunRequest): Promise<ControlPlaneAgentRunGenerationResult> {
    return this.postJson<ControlPlaneAgentRunGenerationResult>(
      "/api/customer-runtimes/agent-runs/generate",
      {
        deploymentId: input.deploymentId,
        runtimeInstanceId: input.runtimeInstanceId,
        requestId: input.requestId,
        runId: input.runId,
        orgId: input.orgId,
        agentId: input.agentId,
        model: input.execution.model,
        prompt: input.execution.prompt,
      },
      false,
    );
  }

  /** Fetch the agent's tool surface (names + JSON schemas, no credentials). */
  async listAgentTools(input: ExecuteAgentRunRequest): Promise<ControlPlaneToolDef[]> {
    const response = await this.postJson<{ result?: { tools?: ControlPlaneToolDef[] }; error?: unknown }>(
      "/api/customer-runtimes/agent-runs/tool-call",
      { ...routingFields(input), method: "tools/list", params: {} },
      false,
    );
    if (response.error) throw new Error(readToolError(response.error));
    return response.result?.tools ?? [];
  }

  /** Run one model step through the control-plane gateway (billed to the org). */
  async generateAgentStep(
    input: ExecuteAgentRunRequest,
    tools: ControlPlaneToolDef[],
    messages: WireMessage[],
  ): Promise<ControlPlaneStepResult> {
    return this.postJson<ControlPlaneStepResult>(
      "/api/customer-runtimes/agent-runs/generate-step",
      { ...routingFields(input), model: input.execution.model, tools, messages },
      false,
    );
  }

  /** Execute one tool call via the signed relay; returns the tool result. */
  async runAgentTool(
    input: ExecuteAgentRunRequest,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    const response = await this.postJson<{ result?: unknown; error?: unknown }>(
      "/api/customer-runtimes/agent-runs/tool-call",
      { ...routingFields(input), method: "tools/call", params: { name, arguments: args } },
      false,
    );
    if (response.error) throw new Error(readToolError(response.error));
    return response.result;
  }

  private async postJson<T>(pathname: string, body: unknown, includeInstallToken: boolean): Promise<T> {
    const bodyText = JSON.stringify(body);
    const headers = new Headers(await this.input.signer.signJson("POST", pathname, bodyText));

    if (includeInstallToken && this.input.installToken) {
      headers.set("authorization", `Bearer ${this.input.installToken}`);
    }

    const response = await fetch(new URL(pathname, this.input.baseUrl), {
      method: "POST",
      headers,
      body: bodyText,
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      throw new RuntimeProtocolError(
        "control_plane_error",
        `Control plane ${pathname} failed with ${response.status}${responseText ? `: ${responseText}` : ""}`,
        502,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

function routingFields(input: ExecuteAgentRunRequest) {
  return {
    deploymentId: input.deploymentId,
    runtimeInstanceId: input.runtimeInstanceId,
    requestId: input.requestId,
    runId: input.runId,
    orgId: input.orgId,
    agentId: input.agentId,
  };
}

function readToolError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "Tool call failed";
}
