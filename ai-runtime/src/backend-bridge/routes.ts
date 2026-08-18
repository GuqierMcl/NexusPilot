import { Elysia } from "elysia";
import { BACKEND_BRIDGE_PATH, type BackendBridgeManager, type BackendBridgeSocket } from "./backend-bridge";

export function backendBridgeRoutes(manager: BackendBridgeManager) {
  return new Elysia({ name: "backend-bridge-routes" }).ws(BACKEND_BRIDGE_PATH, {
    open(ws) {
      manager.open(ws.raw as unknown as BackendBridgeSocket);
    },
    message(ws, message) {
      manager.message(ws.raw as unknown as BackendBridgeSocket, message);
    },
    close(ws) {
      manager.close(ws.raw as unknown as BackendBridgeSocket);
    },
  });
}
