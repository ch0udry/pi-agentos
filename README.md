# pi-agentos

AgentOS role runtime for Pi sessions launched through pi-link.

When this package is loaded in a project, `pi-link <agent-name>` checks project root `.pi/agents/agents.yaml`. If `<agent-name>` is declared there, the Pi session gets that AgentOS profile, referenced rules/docs/checklists, declared skills, tool allow/deny policy, and optional private workspace directory.

If the name is not declared, pi-link behaves normally.

## Prerequisites

```sh
pi install npm:pi-link
npm i -g pi-link
```

`pi-agentos` does not patch or replace pi-link.

## Install

Local development install:

```sh
pi install -l /path/to/pi-agentos
```

GitHub install after this repo is pushed:

```sh
pi install git:github.com/ch0udry/pi-agentos
```

Project-local GitHub install:

```sh
pi install -l git:github.com/ch0udry/pi-agentos
```

## What loads into a project

On first extension load in a trusted project, `pi-agentos` creates project root `.pi/agents` and copies the bundled default AgentOS files into it:

- `agents.yaml`
- agent profiles such as `builder.md`
- `rules/`
- `checklists/`
- `docs/`

Existing files are never overwritten. If a bundled default changes later and your project already has that file, `pi-agentos` does nothing.

## Add an agent

Add an entry to `.pi/agents/agents.yaml`:

```yaml
agents:
  - id: custom
    profile: .pi/agents/custom.md
```

Each entry requires only `id` and `profile`. The profile file controls tools, denied tools, skills, rules, checklists, docs, and optional workspace.

## Profile fields

```yaml
---
name: Builder
tools: [read, grep, find, ls, edit, write, bash]
deny-tools: []
skills: []
rules:
  - rules/builder-rules.md
checklists:
  - checklists/builder-checklist.md
docs:
  - .pi/agents/docs/agentos-workflow.md
cwd: agents-work/builder
---

Profile instructions go here.
```

Rules and checklists may be written relative to `.pi/agents`. Docs and profiles should use project-relative paths.

## Workspace

- missing `cwd`, blank `cwd`, `cwd: .`, and `cwd: parent` mean project root.
- any other relative `cwd` creates that directory under the project root.
- no README, status, log, or work files are created in the workspace.
- Pi's real process cwd and native repo tools stay rooted in the project as normal.

## Tool policy

- `tools` present: active tools become that allowlist, minus denied tools.
- only `deny-tools` present: current active tools minus denied tools.
- neither present: Pi's current/default tools are unchanged.

Unknown tool names are reported visibly. If an allowlist resolves to zero available tools, role activation fails instead of starting a broken session.

## Example

```sh
pi-link builder
```

If `.pi/agents/agents.yaml` contains `id: builder`, the session starts as Builder Agent. If not, it stays a normal linked Pi session.

## Development

```sh
npm install
npm test
```

The Pi extension entry is `index.ts`. Pi loads TypeScript extensions directly; there is no build step for v1.
