import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const [,, action, agentId, ...rest] = process.argv;
const client = new DaemonClient({
  url: "ws://127.0.0.1:6767/ws", clientId: "ss-probe", clientType: "cli",
  reconnect: { enabled: false }, connectTimeoutMs: 10000, suppressSendErrors: true,
});
await client.connect();
try {
  if (action === "usage") {
    console.log(JSON.stringify(await client.listProviderUsage(), null, 1));
  } else if (action === "agents") {
    const p = await client.fetchAgents();
    for (const e of p.entries ?? []) {
      const a = e.agent; if (!a) continue;
      if (agentId && !a.id.startsWith(agentId)) continue;
      console.log(a.id.slice(0,8), a.status, JSON.stringify(a.lastUsage ?? null), (a.title ?? "").slice(0,40));
    }
  } else if (action === "rpc") {
    console.log(JSON.stringify(await client.invokePluginRpc("smart-session", agentId, JSON.parse(rest.join(" ") || "{}")), null, 1));
  } else if (action === "send") {
    const text = rest.join(" ");
    console.log("sending:", JSON.stringify(text));
    console.log(JSON.stringify(await client.sendMessage(agentId, text)));
  }
} finally { await client.close(); }
