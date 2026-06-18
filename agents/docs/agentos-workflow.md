# AgentOS Workflow

Default safe workflow:

1. Ticket defines the task.
2. Scout finds relevant files.
3. Architect defines design and boundaries.
4. Planner creates implementation plan.
5. Reviewer reviews ticket/architecture/plan.
6. Builder implements only approved plan.
7. QA validates behavior.
8. Reviewer reviews final result.
9. Explainer explains to owner.
10. Release checks readiness only when needed.

Builder should not start until ticket, scout, architecture, plan, and reviewer gate are complete.
