import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultDurabilityEnvText,
  defaultLitestreamConfigText,
  durableServiceName,
  renderDurableSystemdUnit,
  shellQuote,
  upsertEnvVar,
} from "../src/durability.js";

test("durableServiceName is deterministic and includes .service suffix", () => {
  const a = durableServiceName("/tmp/ws-a");
  const b = durableServiceName("/tmp/ws-a");
  const c = durableServiceName("/tmp/ws-b");
  assert.equal(a, b);
  assert.equal(a.endsWith(".service"), true);
  assert.notEqual(a, c);
});

test("renderDurableSystemdUnit renders system and user wantedBy targets", () => {
  const systemUnit = renderDurableSystemdUnit({
    workspaceDir: "/work/a",
    scope: "system",
    envFilePath: "/work/a/.coder/litestream.env",
    coderBin: "/usr/local/bin/coder",
  });
  const userUnit = renderDurableSystemdUnit({
    workspaceDir: "/work/a",
    scope: "user",
    envFilePath: "/work/a/.coder/litestream.env",
    coderBin: "/usr/local/bin/coder",
  });
  assert.match(systemUnit, /WantedBy=multi-user\.target/);
  assert.match(userUnit, /WantedBy=default\.target/);
  assert.match(systemUnit, /durability run --workspace/);
});

test("upsertEnvVar updates existing variables and appends missing ones", () => {
  const base = "A=1\nLITESTREAM_REPLICA_URL=old\n";
  const updated = upsertEnvVar(base, "LITESTREAM_REPLICA_URL", "new");
  assert.match(updated, /LITESTREAM_REPLICA_URL=new/);
  const appended = upsertEnvVar("A=1\n", "B", "2");
  assert.match(appended, /B=2/);
});

test("shellQuote handles empty string", () => {
  assert.equal(shellQuote(""), "''");
  assert.equal(shellQuote(null), "''");
  assert.equal(shellQuote(undefined), "''");
});

test("shellQuote wraps simple strings in single quotes", () => {
  assert.equal(shellQuote("hello"), "'hello'");
  assert.equal(shellQuote("/usr/local/bin"), "'/usr/local/bin'");
});

test("shellQuote escapes embedded single quotes", () => {
  assert.equal(shellQuote("it's"), `'it'"'"'s'`);
  assert.equal(shellQuote("a'b'c"), `'a'"'"'b'"'"'c'`);
});

test("shellQuote preserves spaces and special chars", () => {
  assert.equal(shellQuote("hello world"), "'hello world'");
  assert.equal(shellQuote("foo$bar"), "'foo$bar'");
  assert.equal(shellQuote("a\nb"), "'a\nb'");
  assert.equal(shellQuote("a\\b"), "'a\\b'");
});

test("shellQuote handles numeric 0 and false", () => {
  // With ?? operator, 0 and false should be preserved as strings
  assert.equal(shellQuote(0), "'0'");
  assert.equal(shellQuote(false), "'false'");
});

test("default templates include expected keys", () => {
  assert.match(defaultLitestreamConfigText(), /LITESTREAM_REPLICA_URL/);
  assert.match(defaultDurabilityEnvText(), /LITESTREAM_REPLICA_URL=/);
});
