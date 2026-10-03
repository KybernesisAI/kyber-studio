import { test } from "node:test";
import assert from "node:assert/strict";

// Pure module: no Electron, no process spawning.
import {
  buildClaudeArgs,
  describeDenials,
  describeToolUse,
  parseStreamLine,
  stderrTail,
} from "../src/shared/claudeStream.ts";

const cfg = { id: "local:kybsite", name: "kybsite", folder: "/tmp/site", model: "sonnet" };

test("first turn starts a session in auto permission mode", () => {
  assert.deepEqual(buildClaudeArgs(cfg, "hello"), [
    "-p",
    "hello",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    "sonnet",
    "--permission-mode",
    "auto",
  ]);
});

test("later turns resume the session they were given", () => {
  const args = buildClaudeArgs(cfg, "again", "abc-123");
  assert.deepEqual(args.slice(-2), ["--resume", "abc-123"]);
  assert.equal(args.filter((a) => a === "--resume").length, 1);
});

test("the message is one argument, never shell-split", () => {
  const msg = `two words; rm -rf "$HOME" && echo 'x'`;
  const args = buildClaudeArgs(cfg, msg);
  assert.equal(args[1], msg);
});

test("no flag ever loosens permissions", () => {
  const args = buildClaudeArgs(cfg, "x", "s");
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("bypassPermissions"));
});

test("init event yields the session id", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s-1", cwd: "/tmp" });
  assert.deepEqual(parseStreamLine(line), [{ kind: "session", sessionId: "s-1" }]);
});

test("hook and rate-limit events are ignored", () => {
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: "system", subtype: "hook_started", session_id: "x" })), []);
  assert.deepEqual(parseStreamLine(JSON.stringify({ type: "rate_limit_event" })), []);
});

test("assistant text and tool calls come out in order; thinking is dropped", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "git branch", description: "Show branch" } },
      ],
    },
  });
  assert.deepEqual(parseStreamLine(line), [
    { kind: "text", text: "Checking." },
    { kind: "activity", label: "Bash: Show branch", toolUseId: "t1" },
  ]);
});

test("an errored tool result is kept for quoting; a good one is not", () => {
  const bad = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Permission denied by auto mode" }] },
  });
  assert.deepEqual(parseStreamLine(bad), [{ kind: "tool-error", toolUseId: "t1", text: "Permission denied by auto mode" }]);
  const good = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: false, content: "hi" }] },
  });
  assert.deepEqual(parseStreamLine(good), []);
});

test("result event carries session, outcome and denials", () => {
  const line = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    session_id: "s-1",
    permission_denials: [{ tool_name: "Edit", tool_use_id: "t9", tool_input: { file_path: "/tmp/site/a.ts" } }],
  });
  assert.deepEqual(parseStreamLine(line), [
    {
      kind: "result",
      sessionId: "s-1",
      isError: false,
      result: "done",
      denials: [{ toolName: "Edit", toolUseId: "t9", input: { file_path: "/tmp/site/a.ts" } }],
    },
  ]);
});

test("malformed and blank lines yield nothing instead of throwing", () => {
  assert.deepEqual(parseStreamLine(""), []);
  assert.deepEqual(parseStreamLine("{not json"), []);
  assert.deepEqual(parseStreamLine("42"), []);
  assert.deepEqual(parseStreamLine("null"), []);
});

test("denials are described with the CLI's own wording when it gave one", () => {
  const text = describeDenials(
    [
      { toolName: "Edit", toolUseId: "t9", input: { file_path: "/a.ts" } },
      { toolName: "Bash", input: { command: "git push" } },
    ],
    new Map([["t9", "Blocked: edits outside the project"]]),
  );
  assert.match(text, /refused 2 actions/);
  assert.match(text, /Edit: \/a\.ts — Blocked: edits outside the project/);
  assert.match(text, /Bash: git push$/m);
  assert.equal(describeDenials([], new Map()), "");
});

test("tool descriptions are short", () => {
  assert.equal(describeToolUse("Read", { file_path: "/x" }), "Read: /x");
  assert.equal(describeToolUse("Thing", null), "Thing");
  assert.ok(describeToolUse("Bash", { command: "x".repeat(200) }).length < 90);
});

test("stderr tail keeps the last lines", () => {
  const err = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
  assert.equal(stderrTail(err, 2), "line 28\nline 29");
});
