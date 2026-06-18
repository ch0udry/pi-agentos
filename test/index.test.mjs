import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import piAgentOS from "../index.ts";

async function tmpProject() {
  return mkdtemp(path.join(os.tmpdir(), "pi-agentos-ext-test-"));
}

function harness(project, overrides = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = [];
  let activeTools = overrides.activeTools ?? ["read", "grep", "find", "ls", "edit", "write", "bash", "ask_user"];
  let sessionName = overrides.sessionName ?? "builder";
  let flagName = overrides.flagName;
  let entries = overrides.entries ?? [];

  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, config) {
      commands.set(name, config);
    },
    getFlag(name) {
      return name === "link-name" ? flagName : undefined;
    },
    getSessionName() {
      return sessionName;
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
        return entries;
      },
    },
  };

  piAgentOS(pi);

  return {
    pi,
    ctx,
    handlers,
    commands,
    notifications,
    statuses,
    get activeTools() { return activeTools; },
    setSessionName(value) { sessionName = value; },
    setFlagName(value) { flagName = value; },
    setEntries(value) { entries = value; },
  };
}

test("extension startup syncs defaults and activates declared pi-link name", async () => {
  const project = await tmpProject();
  const app = harness(project, { sessionName: "builder" });

  await app.handlers.get("session_start")({}, app.ctx);
  const result = await app.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, app.ctx);

  assert.ok((await readdir(path.join(project, ".pi", "agents"))).includes("agents.yaml"));
  assert.match(await readFile(path.join(project, ".pi", "agents", "builder.md"), "utf8"), /You are the Builder Agent/);
  assert.deepEqual(app.activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
  assert.ok(app.statuses.some((status) => status.key === "agentos" && status.value === "AgentOS: builder"));
  assert.ok(app.notifications.some((note) => note.message.includes("AgentOS role active: builder")));
  assert.match(result.systemPrompt, /AgentOS Active Role/);
  assert.match(result.systemPrompt, /You are the Builder Agent/);
});

test("before_agent_start activates when pi-link saved entry appears after startup", async () => {
  const project = await tmpProject();
  const app = harness(project, { sessionName: "plain" });

  await app.handlers.get("session_start")({}, app.ctx);
  app.setEntries([{ type: "custom", customType: "link-name", data: { name: "planner" } }]);

  const result = await app.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, app.ctx);

  assert.match(result.systemPrompt, /AgentOS Active Role/);
  assert.match(result.systemPrompt, /You are the Planner Agent/);
});

test("direct --link-name flag activates matching agent", async () => {
  const project = await tmpProject();
  const app = harness(project, { flagName: "planner", sessionName: "" });

  await app.handlers.get("session_start")({}, app.ctx);
  const result = await app.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, app.ctx);

  assert.match(result.systemPrompt, /You are the Planner Agent/);
});

test("extension restores baseline tools when a later session name is undeclared", async () => {
  const project = await tmpProject();
  const app = harness(project, { sessionName: "builder" });

  await app.handlers.get("session_start")({}, app.ctx);
  assert.deepEqual(app.activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash"]);

  app.setSessionName("scratch");
  await app.handlers.get("session_start")({}, app.ctx);

  assert.deepEqual(app.activeTools, ["read", "grep", "find", "ls", "edit", "write", "bash", "ask_user"]);
});

test("extension leaves undeclared names alone", async () => {
  const project = await tmpProject();
  const app = harness(project, { sessionName: "scratch", activeTools: ["read"] });

  await app.handlers.get("session_start")({}, app.ctx);
  const result = await app.handlers.get("before_agent_start")({ systemPrompt: "base prompt" }, app.ctx);

  assert.deepEqual(app.activeTools, ["read"]);
  assert.equal(result, undefined);
});

test("agentos-status reports active role and fallback", async () => {
  const project = await tmpProject();
  const app = harness(project, { sessionName: "planner" });

  await app.handlers.get("session_start")({}, app.ctx);
  await app.commands.get("agentos-status").handler("", app.ctx);

  assert.ok(app.notifications.some((note) => note.message.includes("AgentOS active: planner")));
  assert.ok(app.notifications.some((note) => note.message.includes("profile: .pi/agents/planner.md")));

  app.setSessionName("scratch");
  await app.commands.get("agentos-status").handler("", app.ctx);

  assert.ok(app.notifications.some((note) => note.message.includes("Plain pi-link session: no AgentOS agent matched \"scratch\".")));
});

test("agentos-status reports declared agent load errors", async () => {
  const project = await tmpProject();
  const app = harness(project, { sessionName: "broken" });

  await app.handlers.get("session_start")({}, app.ctx);
  await writeFile(path.join(project, ".pi", "agents", "agents.yaml"), `agents:\n  - id: broken\n    profile: .pi/agents/missing.md\n`);
  await app.commands.get("agentos-status").handler("", app.ctx);

  assert.ok(app.notifications.some((note) => note.level === "error" && note.message.includes("AgentOS error for broken")));
});
