import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSharedGatewayUrls } from "../src/main/agentUrls.ts";

function agent(id, name, url) {
  return {
    id,
    name,
    runtime: "kbde",
    url,
    accessMode: "private",
    audience: null,
    reachable: true,
    daemonLabel: "role fleet",
  };
}

test("resolves duplicated daemon URLs through verified per-agent gateway paths", async () => {
  const probed = [];
  const result = await resolveSharedGatewayUrls(
    [
      agent("one", "Mira (Calendar)", "https://nucbox.example:8444"),
      agent("two", "Rowan (Content Manager)", "https://nucbox.example:8444/"),
    ],
    async (url) => {
      probed.push(url);
      return true;
    },
  );

  assert.deepEqual(probed, [
    "https://nucbox.example:8444/agents/Mira%20(Calendar)",
    "https://nucbox.example:8444/agents/Rowan%20(Content%20Manager)",
  ]);
  assert.equal(result[0].url, probed[0]);
  assert.equal(result[1].url, probed[1]);
});

test("keeps a shared URL when the derived route does not answer", async () => {
  const base = "https://legacy.example";
  const result = await resolveSharedGatewayUrls(
    [agent("one", "One", base), agent("two", "Two", base)],
    async () => false,
  );
  assert.deepEqual(result.map((item) => item.url), [base, base]);
});

test("does not reinterpret a unique agent URL", async () => {
  let probes = 0;
  const result = await resolveSharedGatewayUrls(
    [agent("one", "One", "https://one.example")],
    async () => {
      probes += 1;
      return true;
    },
  );
  assert.equal(probes, 0);
  assert.equal(result[0].url, "https://one.example");
});
