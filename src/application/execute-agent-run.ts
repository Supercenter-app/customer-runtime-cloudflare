import {
  assertDeploymentTarget,
  assertRequestWindow,
  type ControlPlaneStepResult,
  type ControlPlaneToolDef,
  type ExecuteAgentRunCompletedResult,
  type ExecuteAgentRunRequest,
  type RuntimeMetadata,
  RuntimeProtocolError,
  type WireMessage,
} from "../domain/protocol";
import type { ReplayStorePort } from "./execute-noop";
import type { ControlPlaneClient } from "../adapters/control-plane-client";

/** A single transcript line persisted to the customer's own store. */
export type RunTranscriptMessage = {
  role: string;
  content: string;
  toolName?: string;
};

export interface RunStorePort {
  isAvailable(): boolean;
  saveTranscript(input: {
    runId: string;
    deploymentId: string;
    messages: RunTranscriptMessage[];
    createdAtMs: number;
  }): Promise<void>;
}

/** Hard cap on model steps so a misbehaving model can't loop forever. */
const MAX_STEPS = 12;

/**
 * Worker-orchestrated agent run (`executionMode: worker`). The loop — the
 * conversation and the decision of which tool to call — runs here, inside the
 * customer's Cloudflare account. Each model step is delegated to the control
 * plane's gateway (billed to the org), and each tool call is delegated to the
 * signed tool-call relay (where credentials live). Neither model keys nor
 * connector credentials ever reach the Worker.
 */
export async function executeAgentRun(input: {
  request: ExecuteAgentRunRequest;
  runtime: RuntimeMetadata;
  replayStore: ReplayStorePort;
  controlPlane: ControlPlaneClient;
  runStore?: RunStorePort;
  now: Date;
}): Promise<ExecuteAgentRunCompletedResult> {
  assertDeploymentTarget(input.request, input.runtime);
  assertRequestWindow(input.request, input.now);

  const replayResult = await input.replayStore.remember(
    input.request.requestId,
    new Date(input.request.expiresAt),
  );
  if (replayResult === "replayed") {
    throw new RuntimeProtocolError("replay_detected", "Execution request has already been used", 409);
  }

  const tools: ControlPlaneToolDef[] = await input.controlPlane.listAgentTools(input.request);

  const messages: WireMessage[] = [];
  if (input.request.execution.initialContext) {
    messages.push({ role: "system", content: input.request.execution.initialContext });
  }
  messages.push({ role: "user", content: input.request.execution.prompt });

  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
  let finalText = "";
  let modelUsed = "";

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result: ControlPlaneStepResult = await input.controlPlane.generateAgentStep(
      input.request,
      tools,
      messages,
    );
    accumulateUsage(usage, result.usage);
    if (result.modelUsed) modelUsed = result.modelUsed;
    if (result.assistant.content) finalText = result.assistant.content;

    messages.push({
      role: "assistant",
      content: result.assistant.content,
      toolCalls: result.assistant.toolCalls,
    });

    if (result.assistant.toolCalls.length === 0) {
      break;
    }

    for (const call of result.assistant.toolCalls) {
      let toolResult: unknown;
      try {
        toolResult = await input.controlPlane.runAgentTool(input.request, call.name, call.args);
      } catch (error) {
        toolResult = { error: error instanceof Error ? error.message : "Tool call failed" };
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        result: stringifyToolResult(toolResult),
      });
    }
  }

  // Data residency: when a customer run store (D1) is configured, the full
  // transcript is persisted inside the customer's account and only the final
  // answer is returned to the control plane. Without a store, fall back to
  // returning the transcript so run content is never lost.
  const transcript = toTranscript(messages);
  let responseMessages: Array<{ role: string; content: string }> = transcript.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (input.runStore?.isAvailable()) {
    try {
      await input.runStore.saveTranscript({
        runId: input.request.runId,
        deploymentId: input.request.deploymentId,
        messages: transcript,
        createdAtMs: input.now.getTime(),
      });
      responseMessages = [{ role: "assistant", content: finalText }];
    } catch (error) {
      // Persisting failed — keep the transcript in the response so it survives,
      // even though that means it reaches the control plane this once.
      console.error("[customer-runtime] failed to persist transcript to D1", error);
    }
  }

  return {
    type: "agent.run.completed",
    requestId: input.request.requestId,
    runId: input.request.runId,
    success: true,
    output: finalText,
    modelUsed: modelUsed || "customer-cloudflare",
    usage,
    responseMessages,
  };
}

function toTranscript(messages: WireMessage[]): RunTranscriptMessage[] {
  return messages.map((message): RunTranscriptMessage => {
    if (message.role === "tool") {
      return { role: "tool", content: message.result, toolName: message.toolName };
    }
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: JSON.stringify({ text: message.content ?? "", toolCalls: message.toolCalls ?? [] }),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function accumulateUsage(
  acc: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number },
  step: ControlPlaneStepResult["usage"],
): void {
  acc.inputTokens += step.inputTokens;
  acc.outputTokens += step.outputTokens;
  acc.totalTokens += step.totalTokens;
  acc.estimatedCostUsd += step.estimatedCostUsd;
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
