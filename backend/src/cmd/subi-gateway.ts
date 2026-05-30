#!/usr/bin/env bun
import { createGatewayServer, loadGatewayConfig } from "../gateway";

try {
  const cfg = loadGatewayConfig();
  const server = createGatewayServer(cfg);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    cfg.store?.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`subi-gateway listening on ${cfg.addr}`);
} catch (error) {
  console.error(`subi-gateway config error: ${error}`);
  process.exit(1);
}
