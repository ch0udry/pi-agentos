import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export const DEFAULT_MAX_INCLUDE_BYTES = 8192;
export const DEFAULT_MAX_CONTEXT_CHARS = 32768;

export type AgentRegistryEntry = {
  id: string;
  profile: string;
};

export type AgentRegistry = {
  registryPath: string;
  entries: AgentRegistryEntry[];
  invalidEntries: Array<{ id: string; errors: string[] }>;
  errors: string[];
};

export type AgentWorkspace = {
  policy: string;
  path: string;
  create: boolean;
};

export type AgentReference = {
  kind: "rule" | "checklist" | "doc";
  source: string;
  path?: string;
  included: boolean;
  content?: string;
  warning?: string;
};

export type AgentProfile = {
  id: string;
  profilePath: string;
  name: string;
  description: string;
  cwd: unknown;
  workspace: AgentWorkspace;
  tools: string[];
  denyTools: string[];
  skills: string[];
  rules: string[];
  checklists: string[];
  docs: string[];
  body: string;
  warnings: string[];
  errors: string[];
  references: AgentReference[];
};

export type ResolvedAgent =
  | { active: true; id: string; profile: AgentProfile; errors: string[]; warnings: string[] }
  | { active: false; id: string; profile?: undefined; errors: string[]; warnings: string[] };

export type ToolPolicy = {
  apply: boolean;
  tools: string[];
  warnings: string[];
  errors: string[];
};

export function normalizeName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim();
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full, rel));
    if (entry.isFile()) out.push(rel);
  }
  return out;
}

export async function syncDefaultAgents(input: { packageAgentsDir: string; projectRoot: string }) {
  const targetRoot = path.join(input.projectRoot, ".pi", "agents");
  await mkdir(targetRoot, { recursive: true });

  const files = await walkFiles(input.packageAgentsDir);
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const rel of files) {
    const source = path.join(input.packageAgentsDir, rel);
    const target = path.join(targetRoot, rel);
    if (!isInside(targetRoot, target)) throw new Error(`Refusing to copy outside .pi/agents: ${rel}`);

    if (await pathExists(target)) {
      skipped.push(rel);
      continue;
    }

    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
    copied.push(rel);
  }

  return { targetRoot, copied, skipped };
}

export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith("---")) return { frontmatter: {}, body: text.trim() };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: text.trim() };
  return {
    frontmatter: YAML.parse(match[1]) ?? {},
    body: text.slice(match[0].length).trim(),
  };
}

export async function loadRegistry(projectRoot: string): Promise<AgentRegistry> {
  const registryPath = path.join(projectRoot, ".pi", "agents", "agents.yaml");
  const text = await readFile(registryPath, "utf8");
  const raw = YAML.parse(text) ?? {};
  const agents = Array.isArray(raw.agents) ? raw.agents : [];
  const errors: string[] = [];
  const invalidEntries: Array<{ id: string; errors: string[] }> = [];

  const entries = agents.map((entry: Record<string, unknown>, index: number) => {
    const id = normalizeName(entry?.id);
    const profile = normalizeName(entry?.profile);
    const entryErrors: string[] = [];
    if (!id) entryErrors.push(`agents[${index}].id is required`);
    if (!profile) entryErrors.push(`agents[${index}].profile is required`);
    if (entryErrors.length) {
      errors.push(...entryErrors);
      if (id) invalidEntries.push({ id, errors: entryErrors });
      return null;
    }
    return { id, profile };
  }).filter((entry: AgentRegistryEntry | null): entry is AgentRegistryEntry => Boolean(entry));

  return { registryPath, entries, invalidEntries, errors };
}

export function resolveProjectPath(projectRoot: string, relPath: unknown, label = "path"): string {
  const value = normalizeName(relPath);
  if (!value) throw new Error(`${label} is required`);
  if (path.isAbsolute(value)) throw new Error(`${label} must be project-relative: ${value}`);

  const resolved = path.resolve(projectRoot, value);
  if (!isInside(projectRoot, resolved)) throw new Error(`${label} escapes project root: ${value}`);
  return resolved;
}

export function resolveReferencePath(projectRoot: string, kind: AgentReference["kind"], source: string): string {
  const value = normalizeName(source);
  if (!value) throw new Error(`${kind} reference is blank`);
  if (path.isAbsolute(value)) throw new Error(`${kind} reference must be project-relative: ${value}`);

  let rel = value;
  if ((kind === "rule" || kind === "checklist") && !value.startsWith(".pi/")) {
    rel = path.join(".pi", "agents", value);
  }

  return resolveProjectPath(projectRoot, rel, `${kind} reference`);
}

export function resolveWorkspace(projectRoot: string, cwdValue: unknown): AgentWorkspace {
  const value = normalizeName(cwdValue);
  if (!value || value === "parent" || value === ".") {
    return { policy: value || "project-root", path: path.resolve(projectRoot), create: false };
  }
  if (path.isAbsolute(value)) throw new Error(`cwd must be project-relative: ${value}`);

  const resolved = path.resolve(projectRoot, value);
  if (!isInside(projectRoot, resolved)) throw new Error(`cwd escapes project root: ${value}`);
  return { policy: value, path: resolved, create: true };
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export async function loadProfile(projectRoot: string, entry: AgentRegistryEntry, options: { maxIncludeBytes?: number } = {}): Promise<AgentProfile> {
  const profilePath = resolveProjectPath(projectRoot, entry.profile, "profile");
  const text = await readFile(profilePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(text);
  const workspace = resolveWorkspace(projectRoot, frontmatter.cwd);

  const profile: AgentProfile = {
    id: entry.id,
    profilePath,
    name: normalizeName(frontmatter.name) || entry.id,
    description: normalizeName(frontmatter.description),
    cwd: frontmatter.cwd,
    workspace,
    tools: stringArray(frontmatter.tools),
    denyTools: stringArray(frontmatter["deny-tools"]),
    skills: stringArray(frontmatter.skills),
    rules: stringArray(frontmatter.rules),
    checklists: stringArray(frontmatter.checklists),
    docs: stringArray(frontmatter.docs),
    body,
    warnings: [],
    errors: [],
    references: [],
  };

  if (!body) profile.warnings.push(`Profile ${entry.id} has an empty body`);
  profile.references = await loadReferences(projectRoot, profile, options);
  return profile;
}

export async function loadReferences(projectRoot: string, profile: AgentProfile, options: { maxIncludeBytes?: number } = {}): Promise<AgentReference[]> {
  const maxBytes = options.maxIncludeBytes ?? DEFAULT_MAX_INCLUDE_BYTES;
  const specs: Array<{ kind: AgentReference["kind"]; source: string }> = [
    ...profile.rules.map((source) => ({ kind: "rule" as const, source })),
    ...profile.checklists.map((source) => ({ kind: "checklist" as const, source })),
    ...profile.docs.map((source) => ({ kind: "doc" as const, source })),
  ];

  const refs: AgentReference[] = [];
  for (const spec of specs) {
    try {
      const filePath = resolveReferencePath(projectRoot, spec.kind, spec.source);
      const info = await stat(filePath);
      if (!info.isFile()) {
        refs.push({ ...spec, path: filePath, included: false, warning: "not a file" });
        continue;
      }
      if (info.size > maxBytes) {
        refs.push({ ...spec, path: filePath, included: false, warning: `too large (${info.size} bytes)` });
        continue;
      }
      refs.push({ ...spec, path: filePath, included: true, content: await readFile(filePath, "utf8") });
    } catch (error) {
      refs.push({ ...spec, included: false, warning: error instanceof Error ? error.message : String(error) });
    }
  }
  return refs;
}

export async function resolveAgent(projectRoot: string, id: string, options: { maxIncludeBytes?: number } = {}): Promise<ResolvedAgent> {
  const registry = await loadRegistry(projectRoot);
  const entry = registry.entries.find((agent) => agent.id === id);
  if (!entry) {
    const invalid = registry.invalidEntries.find((agent) => agent.id === id);
    return { active: false, id, errors: invalid?.errors ?? [], warnings: [] };
  }

  try {
    const profile = await loadProfile(projectRoot, entry, options);
    return { active: true, id, profile, errors: profile.errors, warnings: profile.warnings };
  } catch (error) {
    return { active: false, id, errors: [error instanceof Error ? error.message : String(error)], warnings: [] };
  }
}

export async function ensureWorkspace(profile: AgentProfile): Promise<AgentWorkspace> {
  if (profile.workspace.create) await mkdir(profile.workspace.path, { recursive: true });
  return profile.workspace;
}

export function computeToolPolicy(profile: Pick<AgentProfile, "tools" | "denyTools">, currentTools: string[], allTools: Array<string | { name?: string }>): ToolPolicy {
  const current = [...new Set(currentTools ?? [])];
  const available = new Set((allTools ?? []).map((tool) => typeof tool === "string" ? tool : tool.name).filter(Boolean) as string[]);
  const hasAllow = profile.tools.length > 0;
  const hasDeny = profile.denyTools.length > 0;

  if (!hasAllow && !hasDeny) return { apply: false, tools: current, warnings: [], errors: [] };

  const unknownAllowed = profile.tools.filter((tool) => !available.has(tool));
  const unknownDenied = profile.denyTools.filter((tool) => !available.has(tool));
  const warnings = [
    ...unknownAllowed.map((tool) => `Unknown allowed tool: ${tool}`),
    ...unknownDenied.map((tool) => `Unknown denied tool: ${tool}`),
  ];

  const denied = new Set(profile.denyTools.filter((tool) => available.has(tool)));
  const base = hasAllow ? profile.tools.filter((tool) => available.has(tool)) : current;
  const tools = [...new Set(base.filter((tool) => !denied.has(tool)))];

  if (hasAllow && tools.length === 0) {
    return { apply: false, tools, warnings, errors: ["Tool allowlist resolved to zero available tools"] };
  }

  return { apply: true, tools, warnings, errors: [] };
}

function rel(projectRoot: string, filePath: string): string {
  return path.relative(projectRoot, filePath) || ".";
}

export function buildRolePrompt(projectRoot: string, profile: AgentProfile, options: { availableSkills?: string[]; maxContextChars?: number } = {}): string {
  const availableSkills = options.availableSkills;
  const warnings = [...profile.warnings];
  for (const ref of profile.references) {
    if (ref.warning) warnings.push(`${ref.kind} ${ref.source}: ${ref.warning}`);
  }
  if (Array.isArray(availableSkills) && profile.skills.length > 0) {
    const available = new Set(availableSkills);
    for (const skill of profile.skills) {
      if (!available.has(skill)) warnings.push(`Skill not currently available: ${skill}`);
    }
  }

  const sections = [
    "## AgentOS Active Role",
    `- id: ${profile.id}`,
    `- name: ${profile.name}`,
    profile.description ? `- description: ${profile.description}` : null,
    `- workspace: ${rel(projectRoot, profile.workspace.path)}`,
    profile.tools.length ? `- tools: ${profile.tools.join(", ")}` : null,
    profile.denyTools.length ? `- deny-tools: ${profile.denyTools.join(", ")}` : null,
    profile.skills.length ? `- skills: ${profile.skills.join(", ")}` : null,
    "",
    "### Profile",
    profile.body,
  ].filter((line) => line !== null) as string[];

  const included = profile.references.filter((ref) => ref.included);
  if (included.length) {
    sections.push("", "### Referenced Context");
    for (const ref of included) sections.push(`\n#### ${ref.source}\n\n${ref.content}`);
  }

  const omitted = profile.references.filter((ref) => !ref.included);
  if (omitted.length) {
    sections.push("", "### Referenced Paths");
    for (const ref of omitted) sections.push(`- ${ref.source}${ref.warning ? ` (${ref.warning})` : ""}`);
  }

  if (warnings.length) {
    sections.push("", "### AgentOS Warnings");
    for (const warning of warnings) sections.push(`- ${warning}`);
  }

  let prompt = sections.join("\n");
  const maxChars = options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  if (prompt.length > maxChars) {
    prompt = `${prompt.slice(0, maxChars)}\n\n[AgentOS context truncated at ${maxChars} chars]`;
  }
  return prompt;
}

export function latestLinkNameFromEntries(entries: unknown[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: { name?: unknown } };
    if (entry.type === "custom" && entry.customType === "link-name") {
      const name = normalizeName(entry.data?.name);
      if (name) return name;
    }
  }
  return "";
}

export function resolveLaunchName(input: { envName?: unknown; sessionName?: unknown; entries?: unknown[] }): string {
  return normalizeName(input.envName) || normalizeName(input.sessionName) || latestLinkNameFromEntries(input.entries ?? []);
}
