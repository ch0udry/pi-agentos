import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildRolePrompt,
  computeToolPolicy,
  ensureWorkspace,
  relativeProjectPath,
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

type AgentOSStatus = {
  state: "inactive" | "active" | "fallback" | "error";
  name: string;
  message: string;
  errors: string[];
  warnings: string[];
  profile?: AgentProfile;
};

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const packageAgentsDir = path.join(packageRoot, "agents");
let activeRole: ActiveRole | null = null;
let activeProjectRoot = "";
let baselineTools: string[] | null = null;
let roleChangedTools = false;
let lastResolvedName = "";
let lastStatus: AgentOSStatus = {
  state: "inactive",
  name: "",
  message: "No link/session name resolved. No AgentOS role active.",
  errors: [],
  warnings: [],
};

function resetState() {
  activeRole = null;
  activeProjectRoot = "";
  baselineTools = null;
  roleChangedTools = false;
  lastResolvedName = "";
  lastStatus = {
    state: "inactive",
    name: "",
    message: "No link/session name resolved. No AgentOS role active.",
    errors: [],
    warnings: [],
  };
}

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

function linkFlagName(pi: ExtensionAPI): unknown {
  try {
    return pi.getFlag?.("link-name");
  } catch {
    return undefined;
  }
}

function currentLaunchName(pi: ExtensionAPI, ctx: ExtensionContext): string {
  return resolveLaunchName({
    flagName: linkFlagName(pi),
    envName: process.env.PI_LINK_NAME,
    sessionName: pi.getSessionName?.(),
    entries: entriesFrom(ctx),
  });
}

function setFallbackStatus(pi: ExtensionAPI, ctx: ExtensionContext, name: string) {
  activeRole = null;
  setStatus(ctx, undefined);
  restoreBaselineTools(pi);
  lastStatus = name
    ? {
        state: "fallback",
        name,
        message: `Plain pi-link session: no AgentOS agent matched "${name}".`,
        errors: [],
        warnings: [],
      }
    : {
        state: "inactive",
        name: "",
        message: "No link/session name resolved. No AgentOS role active.",
        errors: [],
        warnings: [],
      };
}

function setErrorStatus(pi: ExtensionAPI, ctx: ExtensionContext, name: string, errors: string[], warnings: string[] = []) {
  activeRole = null;
  setStatus(ctx, undefined);
  restoreBaselineTools(pi);
  lastStatus = {
    state: "error",
    name,
    message: `AgentOS ${name}: ${errors.join("; ")}`,
    errors,
    warnings,
  };
}

async function refreshActiveRole(pi: ExtensionAPI, ctx: ExtensionContext, options: { notifyUser?: boolean } = {}) {
  activeProjectRoot = ctx.cwd;
  await syncDefaultAgents({ packageAgentsDir, projectRoot: ctx.cwd });
  captureBaselineTools(pi);

  const launchName = currentLaunchName(pi, ctx);
  lastResolvedName = launchName;

  if (!launchName) {
    setFallbackStatus(pi, ctx, "");
    return;
  }

  const resolved = await resolveAgent(ctx.cwd, launchName);
  if (!resolved.active) {
    setFallbackStatus(pi, ctx, launchName);
    if (resolved.errors.length) {
      setErrorStatus(pi, ctx, launchName, resolved.errors);
      notify(ctx, lastStatus.message, "error");
    }
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
    setErrorStatus(pi, ctx, launchName, policy.errors, policy.warnings);
    notify(ctx, lastStatus.message, "error");
    return;
  }

  warnings.push(...policy.warnings);
  if (policy.apply) {
    pi.setActiveTools?.(policy.tools);
    roleChangedTools = true;
  }

  activeRole = { name: launchName, profile: resolved.profile, warnings };
  lastStatus = {
    state: "active",
    name: launchName,
    message: `AgentOS active: ${launchName}`,
    errors: [],
    warnings,
    profile: resolved.profile,
  };
  setStatus(ctx, `AgentOS: ${launchName}`);

  if (options.notifyUser) {
    const suffix = warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : "";
    notify(ctx, `AgentOS role active: ${launchName}${suffix}`, warnings.length ? "warning" : "info");
  }
}

function statusText(ctx: ExtensionContext): string {
  if (lastStatus.state === "active" && lastStatus.profile) {
    const profilePath = relativeProjectPath(ctx.cwd, lastStatus.profile.profilePath);
    const workspace = relativeProjectPath(ctx.cwd, lastStatus.profile.workspace.path);
    const warningLine = lastStatus.warnings.length ? `\nwarnings: ${lastStatus.warnings.length}` : "";
    return `AgentOS active: ${lastStatus.name}\nprofile: ${profilePath}\nworkspace: ${workspace}${warningLine}`;
  }

  if (lastStatus.state === "error") {
    return `AgentOS error for ${lastStatus.name}: ${lastStatus.errors.join("; ")}`;
  }

  if (lastStatus.state === "fallback") {
    return lastStatus.message;
  }

  return lastStatus.message;
}

export default function piAgentOS(pi: ExtensionAPI) {
  resetState();

  pi.registerCommand?.("agentos-status", {
    description: "Show active AgentOS role or pi-link fallback status",
    handler: async (_args, ctx) => {
      try {
        await refreshActiveRole(pi, ctx, { notifyUser: false });
      } catch (error) {
        lastStatus = {
          state: "error",
          name: lastResolvedName,
          message: `AgentOS status failed: ${error instanceof Error ? error.message : String(error)}`,
          errors: [error instanceof Error ? error.message : String(error)],
          warnings: [],
        };
      }
      notify(ctx, statusText(ctx), lastStatus.state === "error" ? "error" : "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await refreshActiveRole(pi, ctx, { notifyUser: true });
    } catch (error) {
      activeRole = null;
      setStatus(ctx, undefined);
      lastStatus = {
        state: "error",
        name: lastResolvedName,
        message: `AgentOS failed: ${error instanceof Error ? error.message : String(error)}`,
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      };
      notify(ctx, lastStatus.message, "error");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const launchName = currentLaunchName(pi, ctx);
    if (!activeRole || activeProjectRoot !== ctx.cwd || launchName !== lastResolvedName) {
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
