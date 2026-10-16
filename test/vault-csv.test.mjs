import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChromeCsv } from "../src/renderer/src/components/Vault.tsx";

test("a Chrome password export parses, quotes and all, and rows without the essentials are kept for the server to report", () => {
  const csv = 'name,url,username,password,note\r\nGitHub,https://github.com/,ian,"p,w""x",\r\n"Bank, The",https://bank.example,ian@x.io,secret,"multi\nline"\r\n,,,,\r\n';
  const rows = parseChromeCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: "GitHub", url: "https://github.com/", username: "ian", password: 'p,w"x' });
  assert.equal(rows[1].name, "Bank, The");
  assert.equal(parseChromeCsv("name,url\nA,B\n").length, 0, "a file without username/password columns is not a password export");
});
