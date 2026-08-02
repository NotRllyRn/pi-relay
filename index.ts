import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRelayCommand } from "./src/command.js";
import { RelayLog } from "./src/log.js";
import { relayPaths, RelayController } from "./src/pi.js";
import { Vault } from "./src/vault.js";

export default async function relay(pi: ExtensionAPI): Promise<void> {
  const paths = relayPaths(getAgentDir());
  const controller = await RelayController.create(pi, new Vault(paths.state), new RelayLog(paths.log));
  pi.registerProvider(controller.provider());
  registerRelayCommand(pi, controller);

  pi.on("session_start", async (_event, context) => controller.restore(context));
  pi.on("agent_end", async () => controller.handleAgentEnd());
  pi.on("agent_settled", async () => controller.settled());
  pi.on("input", async (event) => { if (event.source !== "extension") controller.pauseForInput(); });
  pi.on("session_shutdown", async () => controller.detachContext());
}
