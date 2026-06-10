import {
  assertDeploymentTarget,
  assertRequestWindow,
  type ExecuteNoopRequest,
  type ExecuteNoopResult,
  type RuntimeEvent,
  RuntimeProtocolError,
  type RuntimeMetadata,
} from "../domain/protocol";

export interface ReplayStorePort {
  remember(requestId: string, expiresAt: Date): Promise<"stored" | "replayed">;
}

export interface RuntimeEventPort {
  recordEvent(event: RuntimeEvent): Promise<void>;
}

export async function executeNoop(input: {
  request: ExecuteNoopRequest;
  runtime: RuntimeMetadata;
  replayStore: ReplayStorePort;
  events: RuntimeEventPort;
  now: Date;
}): Promise<ExecuteNoopResult> {
  assertDeploymentTarget(input.request, input.runtime);
  assertRequestWindow(input.request, input.now);

  const replayResult = await input.replayStore.remember(input.request.requestId, new Date(input.request.expiresAt));
  if (replayResult === "replayed") {
    throw new RuntimeProtocolError("replay_detected", "Execution request has already been used", 409);
  }

  const completedAt = input.now.toISOString();
  const result: ExecuteNoopResult = {
    accepted: true,
    completed: true,
    runId: input.request.runId,
    requestId: input.request.requestId,
    runtimeInstanceId: input.runtime.runtimeInstanceId,
    completedAt,
    metadata: {
      runtimeVersion: input.runtime.runtimeVersion,
      protocolVersion: input.runtime.protocolVersion,
    },
  };

  await input.events.recordEvent({
    type: "diagnostic.completed",
    deploymentId: input.runtime.deploymentId,
    runtimeInstanceId: input.runtime.runtimeInstanceId,
    requestId: input.request.requestId,
    runId: input.request.runId,
    occurredAt: completedAt,
    metadata: result.metadata,
  });

  return result;
}
