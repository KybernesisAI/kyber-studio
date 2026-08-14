import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The mention matcher, extracted exactly as RichText builds it.
 *
 * Kept here rather than imported because RichText renders JSX and this is
 * about one regex — but the construction below must stay identical to the one
 * in primitives.tsx.
 */
function split(text, mentions) {
  const names = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const escaped = names.map((m) => m.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = escaped.length
    ? new RegExp("(`[^`]+`|https?://\\S+|@(?:" + escaped.join("|") + "))", "g")
    : /(`[^`]+`|https?:\/\/\S+)/g;
  return text.split(pattern);
}

const peers = [{ name: "sid" }, { name: "eve-gtm" }, { name: "Chief" }, { name: "Chief of Staff" }];

test("a reachable agent becomes its own part", () => {
  const parts = split("ask @sid about tomorrow", peers);
  assert.ok(parts.includes("@sid"));
});

test("a longer name wins over a prefix of it", () => {
  // "@Chief" is also a peer, so a naive alternation would stop at it and leave
  // " of Staff" as stray text next to a chip that names the wrong agent.
  const parts = split("ping @Chief of Staff now", peers);
  assert.ok(parts.includes("@Chief of Staff"), `got ${JSON.stringify(parts)}`);
});

test("an @ in front of something unreachable is left as text", () => {
  // Styling it would promise an addressing feature that does not exist.
  const parts = split("email me @ noon, or @nobody", peers);
  assert.ok(!parts.some((p) => p?.startsWith("@")));
});

test("hyphens and dots in a name are matched literally", () => {
  const parts = split("try @eve-gtm", peers);
  assert.ok(parts.includes("@eve-gtm"));
  // A dot in a name must not become "any character".
  const dotted = split("hi @a.b", [{ name: "a.b" }]);
  assert.ok(dotted.includes("@a.b"));
  assert.ok(!split("hi @axb", [{ name: "a.b" }]).some((p) => p?.startsWith("@")));
});

test("code spans and links still win", () => {
  const parts = split("see `@sid` and https://x.ai/@sid", peers);
  assert.ok(parts.includes("`@sid`"));
  assert.ok(parts.includes("https://x.ai/@sid"));
});

test("no reachable agents means no mention matching at all", () => {
  const parts = split("hello @sid", []);
  assert.ok(!parts.some((p) => p?.startsWith("@")));
});
