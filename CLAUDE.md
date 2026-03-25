# OE-Brain Project Instructions

## Mandatory: Use OE-Brain in Every Session

All Claude Code sessions with the oe-brain MCP server connected **must** actively capture context using the `mcp__oe-brain__*` tools. The `/oe-brain` skill defines when and how — follow it strictly.

### The non-negotiable minimum

1. **Session start**: Load context (`get_branch_context`, `list_tasks`)
2. **During work**: Capture decisions and learnings as they happen, not at the end
3. **Session end**: `capture_session_summary` — every session with code changes, no exceptions

### Don't wait to be asked

Capture proactively. If you made a tradeoff, discovered a gotcha, or finished a task — log it immediately. The team depends on this shared knowledge base to avoid re-discovering the same things across sessions.
