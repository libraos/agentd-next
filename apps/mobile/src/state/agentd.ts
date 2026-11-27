import { createAgentdEnvironmentAtoms } from "@t3tools/client-runtime/state/agentd";

import { connectionAtomRuntime } from "../connection/runtime";

/** LibraOS Engine's atoms; read `permissionAtom` on a command to decide whether to offer it. */
export const agentdEnvironment = createAgentdEnvironmentAtoms(connectionAtomRuntime);
