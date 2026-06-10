import type { ControlPlaneRegistrationResult, RegisterRuntimeInput } from "../domain/protocol";

export interface RegisterControlPlanePort {
  registerRuntime(input: RegisterRuntimeInput): Promise<ControlPlaneRegistrationResult>;
}

export async function registerRuntime(
  controlPlane: RegisterControlPlanePort,
  input: RegisterRuntimeInput,
): Promise<ControlPlaneRegistrationResult> {
  return controlPlane.registerRuntime(input);
}
