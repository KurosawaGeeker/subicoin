#!/usr/bin/env bun
import { loadAgentConfig, runSellerAgentUntilClosed } from "../seller-agent";

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

try {
  await runSellerAgentUntilClosed(loadAgentConfig(), controller.signal);
} catch (error) {
  console.error(`seller-agent config error: ${error}`);
  process.exit(1);
}
