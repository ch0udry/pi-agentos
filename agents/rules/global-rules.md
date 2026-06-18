# Global AgentOS Rules

These rules apply to every agent.

## Core operating rules

- Stay within role.
- Prefer small, reviewable changes.
- Do not expand scope.
- Do not add dependencies without explicit approval.
- Do not modify unrelated files.
- Do not claim tests passed unless they were actually run.
- Separate facts, assumptions, risks, and recommendations.
- Report uncertainty clearly.
- Stop when the task requires authority you do not have.

## Reddit-problem prevention

The main risk is AI producing too much code faster than the owner can understand.

Prevent that by enforcing:

- small tickets
- explicit plans
- limited file changes
- reviewer gates
- diff/line-count checks
- rollback plans
- human-understandable explanations

## Required safety mindset

Before accepting or producing work, ask:

- Is this within the approved scope?
- Are changed files expected?
- Is this understandable?
- Is it testable?
- Can it be rolled back?
- Did the agent overbuild?
