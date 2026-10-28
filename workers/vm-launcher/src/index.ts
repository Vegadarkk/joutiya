import launch from "./launch.json";
import { launchOnce, type Env, type Launch } from "./lib";

// Free launcher of joutiya-vm and the free spare VMs, outside Claude: Oracle frees capacity at
// random moments, and a request a minute catches it without any token spent. Its OCI user, joutiya-launcher, may only list
// and create instances in the compartment. The request (src/launch.json) carries no tunnel token:
// `node scripts/oracle-vm.ts tunnels --apply` writes them once the VM runs.
const worker = {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    console.log(await launchOnce(launch as Launch, env, controller.scheduledTime, fetch));
  },
};

export default worker;
