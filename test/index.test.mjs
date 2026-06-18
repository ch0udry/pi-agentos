import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import piAgentOS from "../index.ts";

async function tmpProject() {
  return mkdtemp(path.join(os.tmpdir(), "pi-agentos-ext-test-"));
}

test("extension startup syncs defaults and activates declared pi-link name", async () => {
  const project = await tmpProject();
  const handlers = new Map();
  const notifications = [];
  const statuses = [];
  let activeTools = ["read", "grep", "find", "ls", "edit", "write", "bash", "ask_user"];

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    getSessionName() {
      return "builder";
    },
    getActiveTools() {
      return activeTools;
    },
    getAllTools() {
      return activeTools.map((name) => ({ name }));
    },
    setActiveTools(names) {
      activeTools = names;
    },
  };
  const ctx = {
    cwd: project,
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        statuses.push({ key, value });
      },
    },
    sessionManager: {
      getEntries() {
        return [];
      },
    },
  };

  piAgentOS(pi);
  await handlers.get("session_start")({}, ctx);
  const result = await handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, ctx);

  assert.ok((await readdir(path.join(project, ".pi", "agents"))).includes("agents.yaml"));
  assert.match(await readFile(path.join(project, ".pi", "agents", "builder.md"), "utf8"), /You are the Builder Agent/);
  assert.deepEqual(activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
  assert.ok(statuses.some((status) => status.key === "agentos" && status.value === "AgentOS: builder"));
  assert.ok(notifications.some((note) => note.message.includes("AgentOS role active: builder")));
  assert.match(result.systemPrompt, /AgentOS Active Role/);
  assert.match(result.systemPrompt, /You are the Builder Agent/);
});

test("extension leaves undeclared names alone", async () => {
  const project = await tmpProject();
  const handlers = new Map();
  let setActiveToolsCalled = false;

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    getSessionName() {
      return "scratch";
    },
    getActiveTools() {
      return ["read"];
    },
    getAllTools() {
      return [{ name: "read" }];
    },
    setActiveTools() {
      setActiveToolsCalled = true;
    },
  };
  const ctx = {
    cwd: project,
    ui: { notify() {}, setStatus() {} },
    sessionManager: { getEntries() { return []; } },
  };

  piAgentOS(pi);
  await handlers.get("session_start")({}, ctx);
  const result = await handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, ctx);

  assert.equal(setActiveToolsCalled, false);
  assert.equal(result, undefined);
});
