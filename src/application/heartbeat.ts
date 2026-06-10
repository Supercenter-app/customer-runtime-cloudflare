import type { ControlPlaneHeartbeatResult, HeartbeatInput, RuntimeMetadata } from "../domain/protocol";

export interface HeartbeatControlPlanePort {
  sendHeartbeat(input: HeartbeatInput): Promise<ControlPlaneHeartbeatResult>;
  refreshConfig(input: RuntimeMetadata): Promise<{ configVersion?: string }>;
}

export function buildHeartbeat(input: RuntimeMetadata & { configVersion?: string; now: Date }): HeartbeatInput {
  return {
    deploymentId: input.deploymentId,
    runtimeInstanceId: input.runtimeInstanceId,
    runtimeVersion: input.runtimeVersion,
    protocolVersion: input.protocolVersion,
    capabilities: input.capabilities,
    health: "ok",
    configVersion: input.configVersion,
    checkedAt: input.now.toISOString(),
  };
}

export async function sendHeartbeat(
  controlPlane: HeartbeatControlPlanePort,
  input: RuntimeMetadata & { configVersion?: string; now: Date },
): Promise<ControlPlaneHeartbeatResult> {
  return controlPlane.sendHeartbeat(buildHeartbeat(input));
}

export async function refreshConfig(
  controlPlane: Pick<HeartbeatControlPlanePort, "refreshConfig">,
  input: RuntimeMetadata,
): Promise<{ configVersion?: string }> {
  return controlPlane.refreshConfig(input);
}
