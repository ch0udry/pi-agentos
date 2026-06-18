---
title: "fix: Activate AgentOS roles from pi-link session names"
type: fix
date: 2026-06-18
---

# fix: Activate AgentOS roles from pi-link session names

## Summary

Fix `pi-agentos` so `pi-link <agent-name>` reliably activates the matching AgentOS profile when `<agent-name>` exists in `.pi/agents/agents.yaml`. If the pi-link name does not match an AgentOS agent, the session remains a normal pi-link session. Preserve pi-link's native resume/create behavior, document direct Pi commands for explicit fresh sessions, and add `/agentos-status` so users can verify whether the current linked session is role-backed or plain pi-link.

---

## Problem Frame

A user installed `pi-agentos`, saw the default `.pi/agents` directory populate, then ran `pi-link planner`. pi-link printed its normal session-resolution message and started a session, but the model behaved like a normal Pi session instead of the Planner Agent. The intended product contract is simple: pi-link owns opening and resuming named linked sessions; direct Pi `--link-name` launches provide explicit fresh sessions; pi-agentos maps the resolved link name to a role only when the name is declared in the AgentOS registry.

---

## Requirements

- R1. `pi-link <agent-name>` must activate the AgentOS profile whose `id` matches `<agent-name>` when the registry declares it.
- R2. `pi-link <session-name>` must remain normal pi-link behavior when `<session-name>` is not declared in the registry.
- R3. Activation must not require a new launcher, new user-facing flag, or changes to pi-link or Pi coding agent.
- R4. Name detection must not rely only on `PI_LINK_NAME`, because pi-link may consume it before pi-agentos reads it.
- R5. Activation must retry at the last cheap moment before the model turn so extension load order cannot silently produce a plain session.
- R6. `/agentos-status` must report active role state, including whether the current session is AgentOS-backed or plain pi-link fallback.
- R7. Status output must distinguish registry/profile/tool-policy failures from a valid no-match fallback.
- R8. Existing default-agent sync, no-overwrite behavior, workspace safety, and tool-policy restore behavior must remain unchanged.
- R9. `pi-link <agent-name>` must remain the normal resume path: resume an existing cwd session when one exists, otherwise allow pi-link's normal new-session behavior.
- R10. `pi --link --link-name <agent-name>` must be documented as the explicit fresh persistent AgentOS session path.
- R11. `pi --link --link-name <agent-name> --no-session` must be documented as the explicit fresh non-persistent scratch path.

---

## Key Technical Decisions

- **Keep `pi-link <agent-name>` as the resume/create linked-session UX:** pi-link already provides cwd-scoped session lookup and new-session creation, so pi-agentos should activate roles from the resulting link name rather than introduce a second launcher.
- **Use direct Pi `--link-name` for explicit fresh sessions:** pi-link rejects resume/fresh-style flags before extensions load, so fresh control belongs in documented Pi commands, not in pi-agentos flags.
- **Resolve link identity from durable session state, not only env:** use env when available, but prefer a resolver that can also read Pi session name and pi-link's saved `link-name` custom entry after pi-link has consumed `PI_LINK_NAME`.
- **Refresh activation in `before_agent_start`:** `session_start` can race extension ordering; the pre-agent hook is the final point where pi-agentos can detect the resolved name and inject role context before the model sees the prompt.
- **Add a first-class status command:** notifications are transient, while `/agentos-status` gives a repeatable check during manual testing and multi-terminal orchestration.
- **Treat no-match as a clean fallback:** an undeclared pi-link name is not an error; it should show as plain pi-link in status and avoid noisy warnings during normal linked-session use.

---

## High-Level Technical Design

```mermaid
flowchart TB
  Launch[pi-link planner] --> Pi[Pi resumes or creates linked session]
  Fresh[pi --link --link-name planner] --> Pi
  Scratch[pi --link --link-name planner --no-session] --> Pi
  Pi --> Link[pi-link resolves link/session name]
  Link --> AgentOS[pi-agentos refreshes active role]
  AgentOS --> Name{resolved name?}
  Name -->|planner| Registry{agents.yaml has id?}
  Name -->|none| Plain[plain pi-link fallback]
  Registry -->|yes| Role[load planner profile]
  Registry -->|no| Plain
  Role --> Tools[apply tool policy]
  Tools --> Prompt[inject AgentOS role before model turn]
  Plain --> PromptNoop[no prompt/tool changes]
  Role --> Status[/agentos-status: active role]
  Plain --> StatusPlain[/agentos-status: pi-link only]
```

---

## Implementation Units

### U1. Harden pi-link name resolution

- **Goal:** Make the pure resolver correctly identify a pi-link name from all sources available to pi-agentos.
- **Requirements:** R1-R5, R7
- **Dependencies:** None
- **Files:**
  - `src/agentos.ts`
  - `test/agentos.test.mjs`
- **Approach:** Extend the launch-name resolver to support the actual shapes returned by Pi session branch entries and pi-link custom entries. Keep source precedence explicit: live env when present, saved pi-link `link-name`, then Pi session name if no better link name exists. This same resolver must support `pi-link planner` and direct `pi --link --link-name planner` sessions.
- **Patterns to follow:** Existing `resolveLaunchName` and `latestLinkNameFromEntries`; upstream pi-link records a `link-name` custom entry and can set the Pi session name only through the wrapper env path.
- **Test scenarios:**
  - Given `PI_LINK_NAME=planner`, resolver returns `planner`.
  - Given a saved pi-link custom entry for `planner` and no env, resolver returns `planner`.
  - Given a Pi session name `planner` and no saved link entry, resolver returns `planner`.
  - Given direct Pi launch with `--link-name planner` causes pi-link to save or expose link name state, resolver returns `planner`.
  - Given both a saved link name and unrelated session name, resolver returns the saved link name.
  - Given no usable source, resolver returns blank and does not activate a role.
- **Verification:** Unit tests cover env, session name, saved entry, precedence, and no-source fallback.

### U2. Make activation resilient to extension ordering

- **Goal:** Ensure `pi-link planner` becomes Planner Agent even if pi-link consumes the env var before pi-agentos `session_start` runs.
- **Requirements:** R1-R5, R8
- **Dependencies:** U1
- **Files:**
  - `index.ts`
  - `test/index.test.mjs`
- **Approach:** Keep the current `session_start` refresh, but make `before_agent_start` always re-evaluate activation when no role is active or when the resolved name changes. Store the last resolved name and active state so no-match fallback stays clean and tool restoration only runs after a role had changed tools.
- **Patterns to follow:** Current `refreshActiveRole`, baseline tool capture/restore, and prompt injection in `before_agent_start`.
- **Test scenarios:**
  - Given pi-link's saved entry appears only after initial startup, `before_agent_start` activates the matching role.
  - Given `planner` is declared, `before_agent_start` injects Planner context before the model turn.
  - Given `scratch` is undeclared, no AgentOS prompt is injected and no tool changes occur.
  - Given a role was active and the session later resolves to an undeclared name, baseline tools are restored once.
  - Given profile loading fails for a declared name, no partial role is injected and status reports an error.
- **Verification:** Extension-level tests simulate handler ordering and prove activation happens before prompt injection.

### U3. Add `/agentos-status`

- **Goal:** Give users a direct way to confirm whether the current pi-link session is AgentOS-backed.
- **Requirements:** R6-R7
- **Dependencies:** U1, U2
- **Files:**
  - `index.ts`
  - `test/index.test.mjs`
  - `README.md`
- **Approach:** Register a Pi command named `agentos-status`. The command should refresh state, then report one of three states: active AgentOS role, plain pi-link fallback because no registry match exists, or AgentOS error because a declared role could not load.
- **Patterns to follow:** Pi extension command registration patterns in existing examples, plus the current notification/status UI helpers in `index.ts`.
- **Test scenarios:**
  - Given active `planner`, command output includes active role, profile path, workspace, and warnings count.
  - Given undeclared `scratch`, command output says plain pi-link session and no AgentOS role active.
  - Given declared `planner` with missing profile, command output reports the load error.
  - Given no link/session name, command output says no AgentOS role active.
- **Verification:** Command tests call the registered handler directly and assert the user-visible output for active, fallback, and error states.

### U4. Document the corrected contract and smoke path

- **Goal:** Make user docs match the intended runtime: pi-link remains the resume/create launcher, direct Pi `--link-name` is the fresh-session path, and pi-agentos activates roles by matching names.
- **Requirements:** R1-R8
- **Dependencies:** U1-U3
- **Files:**
  - `README.md`
- **Approach:** Update examples to say `pi-link planner` is the normal resume/create flow. Explain that pi-link's `No "planner" in this cwd... Starting new session.` message is normal when it creates a new session, not an AgentOS failure. Document `pi --link --link-name planner` for a fresh persistent session and `pi --link --link-name planner --no-session` for a fresh scratch session. Add `/agentos-status` examples for active and fallback sessions.
- **Test scenarios:**
  - Test expectation: none -- documentation-only change.
- **Verification:** README describes the resume, fresh persistent, fresh scratch, fallback, and status-command behavior without recommending a separate AgentOS launcher.

---

## Acceptance Examples

- AE1. Given `planner` is declared in `.pi/agents/agents.yaml`, when the user runs `pi-link planner`, then the next agent turn includes Planner Agent context.
- AE2. Given `scratch` is not declared in `.pi/agents/agents.yaml`, when the user runs `pi-link scratch`, then the session behaves as normal pi-link without AgentOS role injection.
- AE2a. Given the user wants a fresh persistent Planner session, when they run `pi --link --link-name planner`, then pi-agentos activates Planner Agent in the new linked session.
- AE2b. Given the user wants a fresh non-persistent Planner scratch session, when they run `pi --link --link-name planner --no-session`, then pi-agentos activates Planner Agent without saving a resumable session.
- AE3. Given the user runs `/agentos-status` in an active Planner session, then the command reports `planner` as active and shows the profile path.
- AE4. Given the user runs `/agentos-status` in an undeclared linked session, then the command reports plain pi-link fallback rather than an error.
- AE5. Given pi-link consumes `PI_LINK_NAME` before pi-agentos startup handling, then pi-agentos still activates from saved link/session state before the model turn.

---

## Scope Boundaries

- Do not patch, fork, wrap, or replace pi-link.
- Do not add a `pi-agentos <agent-name>` launcher for this fix.
- Do not add user-facing launch flags for AgentOS activation.
- Do not add unsupported `pi-link planner --resume`, `pi-link planner --fresh`, or similar flags; pi-link rejects those before pi-agentos can handle them.
- Do not change default-agent sync semantics.
- Do not warn on normal undeclared pi-link names outside `/agentos-status`.

---

## Risks & Dependencies

- **Session entry shape:** Pi's session branch APIs may expose custom entries differently than current tests assume; implementation should inspect the actual branch shape while keeping pure resolver tests around observed variants.
- **Extension ordering:** Both pi-link and pi-agentos run lifecycle handlers; the plan relies on pre-agent refresh to absorb startup ordering differences.
- **Status command output channel:** Pi command handlers may prefer returning text or notifying UI depending on API shape; implementation should follow current Pi examples and test the command handler directly.

---

## Sources / Research

- `index.ts` currently resolves names from `PI_LINK_NAME`, Pi session name, and session entries, then refreshes again from `before_agent_start` when no active role exists.
- `src/agentos.ts` already contains `latestLinkNameFromEntries` and `resolveLaunchName`, but tests need to cover the actual pi-link ordering and custom-entry shapes.
- Upstream pi-link records a `link-name` custom entry, consumes `PI_LINK_NAME`, and prints `Starting new session` when it creates a named session instead of finding a local one.
- pi-link's shell launcher rejects resume/fresh-style managed flags, so explicit fresh AgentOS sessions must use Pi's existing `--link --link-name` flow instead of pi-link flags.
