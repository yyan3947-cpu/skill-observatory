---
name: skill-radar
description: Use at the beginning of tasks that may match an installed Skill, when selecting a workflow, or when the user asks which capability is available. Match the current request against the synchronized local Skill catalog, remind the user of at most three high-relevance Skills, and stay quiet when nothing qualifies.
---

# Skill Radar

Identify useful installed Skills before continuing the user's task.

## Workflow

1. Reduce the current request to one short task query. Preserve the user's concrete subject and requested artifact, but exclude secrets and unrelated conversation history.
2. Run `node scripts/recommend.mjs --query "<task query>"` from this Skill directory.
3. Parse the returned JSON array.
4. If the array is empty, say nothing about Skill availability and continue the original task.
5. If it contains results, emit one concise line beginning with `可用 Skill：`. Include at most three Skill names and their returned `reasonZh` values.
6. Continue the original task. Follow every applicable Skill's own trigger rules and instructions; the reminder does not replace them.

Do not pause for confirmation merely because a relevant Skill exists. Do not recommend a result omitted by the script. Clearly retain `需配置`, `异常`, or `待检查` status when returned.

## Catalog failures

If the catalog or script is unavailable during implicit use, continue silently. If the user explicitly invokes `$skill-radar`, explain that the local dashboard must be opened or synchronized before recommendations can be refreshed.
