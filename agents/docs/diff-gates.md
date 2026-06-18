# Diff Gates

Use these checks after Builder:

```bash
git status --short
git diff --stat
wc -l <changed-file>
```

Acceptance rules:

- Expected files only.
- No unrelated changes.
- No unapproved dependencies.
- No broad rewrites.
- Prefer small diffs.
- Large files require reviewer justification.
- Reject code the owner cannot understand at a high level.
