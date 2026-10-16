import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalPrompt, money, parseSpendRequestAsk, parseVaultItemAsk, vaultSavedAnswer } from "../src/shared/asks.ts";

test("marked prompts parse into their card data and the sentence everyone else sees", () => {
  const v = parseVaultItemAsk('[kyb:vault-item] {"kind":"login","site":"https://github.com","fields":["username","password"]}\nI need a login for https://github.com.');
  assert.equal(v.ask.kind, "login");
  assert.equal(v.text, "I need a login for https://github.com.");
  const s = parseSpendRequestAsk('[kyb:spend-request] {"id":"lsrq_1","amount":100,"currency":"usd","merchant":"Wikimedia Foundation","approval_url":"https://app.link.com/x","status":"pending_approval"}\nA purchase…');
  assert.equal(s.ask.amount, 100);
  assert.equal(parseVaultItemAsk("Deploy?"), null);
  assert.equal(parseSpendRequestAsk("[kyb:spend-request] not json\nx"), null);
  assert.equal(vaultSavedAnswer("abc"), "vault:abc");
});

test("eve's approval prompt reads as a question about the tool, and money formats", () => {
  assert.deepEqual(approvalPrompt("Approve tool call: create_spend_request"), { tool: "create_spend_request", title: "Allow create spend request?" });
  assert.equal(approvalPrompt("Which colour?"), null);
  assert.match(money(100, "usd"), /1\.00/);
});
