import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildRolePrompt,
  computeToolPolicy,
  ensureWorkspace,
  resolveAgent,
  resolveLaunchName,
  syncDefaultAgents,
  type AgentProfile,
} from "./src/agentos.ts";

type ActiveRole = {
  name: string;
  profile: AgentProfile;
  warnings: string[];
};

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const packageAgentsDir = path.join(packageRoot, "agents");
let activeRole: ActiveRole | null = null;
let activeProjectRoot = "";
let baselineTools: string[] | null = null;
let roleChangedTools = false;

function entriesFrom(ctx: ExtensionContext): unknown[] {
  try {
    return ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  ctx.ui?.notify?.(message, level);
}

function setStatus(ctx: ExtensionContext, value: string | undefined) {
  try {
    ctx.ui?.setStatus?.("agentos", value ?? "");
  } catch {
    // Status UI is nice-to-have.
  }
}

function captureBaselineTools(pi: ExtensionAPI) {
  if (!baselineTools) baselineTools = [...(pi.getActiveTools?.() ?? [])];
}

function restoreBaselineTools(pi: ExtensionAPI) {
  if (roleChangedTools && baselineTools) {
    pi.setActiveTools?.(baselineTools);
    roleChangedTools = false;
  }
}

async function refreshActiveRole(pi: ExtensionAPI, ctx: ExtensionContext, options: { notifyUser?: boolean } = {}) {
  activeProjectRoot = ctx.cwd;
  await syncDefaultAgents({ packageAgentsDir, projectRoot: ctx.cwd });
  captureBaselineTools(pi);

  const launchName = resolveLaunchName({
    envName: process.env.PI_LINK_NAME,
    sessionName: pi.getSessionName?.(),
    entries: entriesFrom(ctx),
  });

  if (!launchName) {
    activeRole = null;
    setStatus(ctx, undefined);
    restoreBaselineTools(pi);
    return;
  }

  const resolved = await resolveAgent(ctx.cwd, launchName);
  if (!resolved.active) {
    activeRole = null;
    setStatus(ctx, undefined);
    restoreBaselineTools(pi);
    if (resolved.errors.length) notify(ctx, `AgentOS ${launchName}: ${resolved.errors.join("; ")}`, "error");
    return;
  }

  await ensureWorkspace(resolved.profile);

  const warnings = [...resolved.warnings];
  const policy = computeToolPolicy(
    resolved.profile,
    baselineTools ?? pi.getActiveTools?.() ?? [],
    pi.getAllTools?.() ?? [],
  );

  if (policy.errors.length) {
    activeRole = null;
    setStatus(ctx, undefined);
    restoreBaselineTools(pi);
    notify(ctx, `AgentOS ${launchName}: ${policy.errors.join("; ")}`, "error");
    return;
  }

  warnings.push(...policy.warnings);
  if (policy.apply) {
    pi.setActiveTools?.(policy.tools);
    roleChangedTools = true;
  }

  activeRole = { name: launchName, profile: resolved.profile, warnings };
  setStatus(ctx, `AgentOS: ${launchName}`);

  if (options.notifyUser) {
    const suffix = warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : "";
    notify(ctx, `AgentOS role active: ${launchName}${suffix}`, warnings.length ? "warning" : "info");
  }
}

export default function piAgentOS(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await refreshActiveRole(pi, ctx, { notifyUser: true });
    } catch (error) {
      activeRole = null;
      setStatus(ctx, undefined);
      notify(ctx, `AgentOS failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!activeRole || activeProjectRoot !== ctx.cwd) {
      try {
        await refreshActiveRole(pi, ctx, { notifyUser: false });
      } catch {
        return undefined;
      }
    }

    if (!activeRole) return undefined;
    const profile = {
      ...activeRole.profile,
      warnings: [...new Set(activeRole.warnings)],
    };
    const rolePrompt = buildRolePrompt(ctx.cwd, profile);
    return { systemPrompt: `${event.systemPrompt}\n\n${rolePrompt}` };
  });
}
