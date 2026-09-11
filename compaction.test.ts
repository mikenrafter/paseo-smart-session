import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { continuationInstructions } from "./shared/governor.ts";

interface ToolDescription {
  name: string;
  inputSchema: {
    properties?: Record<string, unknown>;
  };
}

async function agentTools(): Promise<ToolDescription[]> {
  const child = spawn(process.execPath, ["mcp.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PASEO_AGENT_ID: "agent-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
      .map((request) => JSON.stringify(request))
      .join("\n") + "\n",
  );

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  const response = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((message) => message.id === 2);
  return response.result.tools;
}

test("request_compaction lets the agent choose whether and how to continue", async () => {
  const request = (await agentTools()).find((tool) => tool.name === "request_compaction");
  assert.ok(request);
  assert.ok(request.inputSchema.properties?.continue_after_compaction);
  assert.ok(request.inputSchema.properties?.continue_message);
});

test("continuation delivery honours the agent's choice and exact message", () => {
  assert.equal(
    continuationInstructions({
      continueAfterCompaction: false,
      continuationMessage: null,
      statePath: "/tmp/state.md",
    }),
    null,
  );

  const custom = "Open the release checklist and start with the pending verification step.";
  assert.equal(
    continuationInstructions({
      continueAfterCompaction: true,
      continuationMessage: custom,
      statePath: "/tmp/state.md",
    }),
    custom,
  );

  const fallback = continuationInstructions({
    continueAfterCompaction: true,
    continuationMessage: null,
    statePath: "/tmp/state.md",
  });
  assert.match(fallback ?? "", /\/tmp\/state\.md/);
  assert.match(fallback ?? "", /Current step/);
});
