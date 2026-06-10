import { createRuntimeApp, type CustomerRuntimeEnv } from "./composition-root";
import { ReplayStoreDurableObject } from "./adapters/replay-store";

export { ReplayStoreDurableObject };

const worker = {
  fetch(request: Request, env: CustomerRuntimeEnv): Promise<Response> {
    return createRuntimeApp(env).fetch(request);
  },

  async scheduled(_event: unknown, env: CustomerRuntimeEnv): Promise<void> {
    await createRuntimeApp(env).scheduled();
  },
};

export default worker;
