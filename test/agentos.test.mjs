import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildRolePrompt,
  computeToolPolicy,
  loadProfile,
  loadRegistry,
  resolveAgent,
  resolveLaunchName,
  resolveWorkspace,
  syncDefaultAgents,
} from "../src/agentos.ts";

async function tmpProject() {
  return mkdtemp(path.join(os.tmpdir(), "pi-agentos-test-"));
}

async function write(root, rel, content) {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

test("syncDefaultAgents copies missing defaults and never overwrites", async () => {
  const source = await tmpProject();
  const project = await tmpProject();
  await write(source, "agents.yaml", "agents: []\n");
  await write(source, "builder.md", "default builder\n");
  await write(source, "rules/builder-rules.md", "rules\n");
  await write(project, ".pi/agents/builder.md", "local builder\n");

  const result = await syncDefaultAgents({ packageAgentsDir: source, projectRoot: project });

  assert.deepEqual(result.copied.sort(), ["agents.yaml", path.join("rules", "builder-rules.md")].sort());
  assert.deepEqual(result.skipped, ["builder.md"]);
  assert.equal(await readFile(path.join(project, ".pi/agents/builder.md"), "utf8"), "local builder\n");
});

test("registry requires only id and profile", async () => {
  const project = await tmpProject();
  await write(project, ".pi/agents/agents.yaml", `agents:\n  - id: builder\n    profile: .pi/agents/builder.md\n  - id: \n    profile: .pi/agents/missing-id.md\n  - id: missing-profile\n`);

  const registry = await loadRegistry(project);

  assert.deepEqual(registry.entries, [{ id: "builder", profile: ".pi/agents/builder.md" }]);
  assert.deepEqual(registry.errors, ["agents[1].id is required", "agents[2].profile is required"]);
});

test("workspace defaults project root for blank, missing, dot, and parent", () => {
  const root = "/tmp/project";
  for (const value of [undefined, "", ".", "parent"]) {
    const workspace = resolveWorkspace(root, value);
    assert.equal(workspace.path, path.resolve(root));
    assert.equal(workspace.create, false);
  }
});

test("workspace rejects paths outside project root", () => {
  assert.throws(() => resolveWorkspace("/tmp/project", "../outside"), /escapes project root/);
  assert.throws(() => resolveWorkspace("/tmp/project", "/tmp/elsewhere"), /project-relative/);
});

test("loadProfile loads references and reports missing references", async () => {
  const project = await tmpProject();
  await write(project, ".pi/agents/builder.md", `---\nname: Builder\ntools: [read, edit]\ndeny-tools: [bash]\nrules:\n  - rules/builder-rules.md\ndocs:\n  - .pi/agents/docs/missing.md\ncwd: agents-work/builder\n---\nBuild things.\n`);
  await write(project, ".pi/agents/rules/builder-rules.md", "Only approved plans.\n");

  const profile = await loadProfile(project, { id: "builder", profile: ".pi/agents/builder.md" });

  assert.equal(profile.name, "Builder");
  assert.deepEqual(profile.tools, ["read", "edit"]);
  assert.deepEqual(profile.denyTools, ["bash"]);
  assert.equal(profile.workspace.path, path.join(project, "agents-work", "builder"));
  assert.equal(profile.workspace.create, true);
  assert.equal(profile.references[0].included, true);
  assert.equal(profile.references[1].included, false);
  assert.match(profile.references[1].warning, /ENOENT/);
});

test("resolveAgent no-ops for undeclared names and errors on missing profiles", async () => {
  const project = await tmpProject();
  await write(project, ".pi/agents/agents.yaml", `agents:\n  - id: builder\n    profile: .pi/agents/missing.md\n`);

  assert.deepEqual(await resolveAgent(project, "scratch"), { active: false, id: "scratch", errors: [], warnings: [] });

  const missing = await resolveAgent(project, "builder");
  assert.equal(missing.active, false);
  assert.match(missing.errors[0], /ENOENT/);
});


test("resolveAgent does not let unrelated invalid registry entries block a valid agent", async () => {
  const project = await tmpProject();
  await write(project, ".pi/agents/agents.yaml", `agents:\n  - id: builder\n    profile: .pi/agents/builder.md\n  - id: broken\n`);
  await write(project, ".pi/agents/builder.md", `---\nname: Builder\n---\nBuild things.\n`);

  const resolved = await resolveAgent(project, "builder");

  assert.equal(resolved.active, true);
  assert.equal(resolved.profile.name, "Builder");
});

test("tool policy supports allowlist, denylist, both, unknowns, and no-op", () => {
  const all = [{ name: "read" }, { name: "edit" }, { name: "bash" }];

  assert.deepEqual(computeToolPolicy({ tools: ["read"], denyTools: [] }, ["read", "edit", "bash"], all), {
    apply: true,
    tools: ["read"],
    warnings: [],
    errors: [],
  });
  assert.deepEqual(computeToolPolicy({ tools: [], denyTools: ["bash"] }, ["read", "bash"], all).tools, ["read"]);
  assert.deepEqual(computeToolPolicy({ tools: ["read", "bash"], denyTools: ["bash"] }, ["read", "bash"], all).tools, ["read"]);
  assert.deepEqual(computeToolPolicy({ tools: ["read", "missing"], denyTools: [] }, ["read"], all).warnings, ["Unknown allowed tool: missing"]);
  assert.deepEqual(computeToolPolicy({ tools: ["missing"], denyTools: [] }, ["read"], all).errors, ["Tool allowlist resolved to zero available tools"]);
  assert.equal(computeToolPolicy({ tools: [], denyTools: [] }, ["read"], all).apply, false);
});

test("role prompt includes profile and referenced context with warnings", async () => {
  const project = await tmpProject();
  await write(project, ".pi/agents/builder.md", `---\nname: Builder\nrules:\n  - rules/builder-rules.md\n---\nBuild things.\n`);
  await write(project, ".pi/agents/rules/builder-rules.md", "Rule text.\n");
  const profile = await loadProfile(project, { id: "builder", profile: ".pi/agents/builder.md" });

  const prompt = buildRolePrompt(project, profile);

  assert.match(prompt, /AgentOS Active Role/);
  assert.match(prompt, /Build things/);
  assert.match(prompt, /Rule text/);
});

test("launch name prefers flag, env, saved link-name, then session", () => {
  assert.equal(resolveLaunchName({ flagName: " direct ", envName: "env", sessionName: "session" }), "direct");
  assert.equal(resolveLaunchName({ envName: " builder ", sessionName: "session" }), "builder");
  assert.equal(resolveLaunchName({ sessionName: " session " }), "session");
  assert.equal(resolveLaunchName({ sessionName: "session", entries: [{ type: "custom", customType: "link-name", data: { name: "saved" } }] }), "saved");
  assert.equal(resolveLaunchName({ sessionName: "session", entries: [{ type: "custom", customType: "link-name", details: { name: "details" } }] }), "details");
  assert.equal(resolveLaunchName({ sessionName: "session", entries: [{ type: "custom", customType: "link-name", content: "content" }] }), "content");
  assert.equal(resolveLaunchName({}), "");
});
