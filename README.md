# OE Brain

**OE Brain** is a shared knowledge base for the engineering team. It automatically captures what you're working on — commits, decisions, learnings, tasks — and makes it searchable from within Claude Code. Think of it as persistent memory across sessions: what you learned yesterday is available to you (and your teammates) today.

Under the hood, it stores context entries in PostgreSQL with vector embeddings for semantic search.

## How It Works

```
Capture Flow:
  Claude Code hooks (commit, PR) → MCP server → API → PostgreSQL + vault

Retrieval Flow:
  Claude Code → MCP tools → API → vector search → context returned

Ask Flow:
  Claude Code → MCP / API → intent detection → retrieval + LLM reasoning → answer
```

## Architecture

Two modes of operation:

- **Server mode** — runs the API server with direct database access, Ollama embeddings, and an Obsidian vault. Deployed to Kubernetes.
- **API client mode** — the MCP server delegates to the remote API. No local database, Ollama, or vault needed. **This is the team setup.**

## Team Setup (API Client Mode)

This is the quickest way to get started. The MCP server runs locally and talks to the shared API server on the cluster.

### 1. Install

```bash
git clone <repo-url> && cd oe-brain
npm install && npm run build
npm link   # registers `oe-brain` and `oe-brain-mcp` globally
```

### 2. Configure

Create `~/.oe-brain/config.yml`:

```yaml
api:
  base_url: http://34.66.86.52:3000
  api_token: ${OE_BRAIN_API_TOKEN}

projects:
  my-project:
    repos:
      my-repo: ~/Code/my-repo
```

Set the environment variable:

```bash
export OE_BRAIN_API_TOKEN="<ask your team lead for the shared token>"
```

The `projects` map lets the MCP server auto-detect which project/repo you're working in based on your current directory.

### 3. Register with Claude Code

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "oe-brain": {
      "command": "oe-brain-mcp"
    }
  }
}
```

Add hooks to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "command": "oe-brain capture-hook --event post-commit"
      }
    ],
    "SessionStart": [
      {
        "command": "oe-brain session-context"
      }
    ]
  }
}
```

### 4. Install the Skill

Copy the OE-Brain skill so Claude Code knows how and when to use the MCP tools:

```bash
cp -r .claude/skills/oe-brain ~/.claude/skills/oe-brain
```

### 5. Verify

Start a Claude Code session. You should see context loaded at startup and have access to all MCP tools (`search_context`, `capture_decision`, `list_tasks`, etc.).

## MCP Tools

### Retrieval

| Tool | Purpose |
|------|---------|
| `search_context` | Semantic search across all context entries |
| `get_branch_context` | Context for current/specified branch |
| `get_project_context` | All recent context for a project |
| `get_pr_context` | Context for a specific PR |
| `get_related` | Find related context entries by topic |
| `get_standup` | Recent GitHub activity summary |

### Capture

| Tool | Purpose |
|------|---------|
| `capture_decision` | Architecture or design decision with rationale |
| `capture_learned` | Technique, gotcha, pattern, or insight |
| `capture_status` | Current work status snapshot |
| `capture_session_summary` | End-of-session summary with next steps |
| `capture_task` | Task or TODO item |
| `complete_task` | Mark a task as done (fuzzy matches title) |
| `list_tasks` | List open or completed tasks |
| `capture_bookmark` | Save a link (article, video) for later |

### Other

| Tool | Purpose |
|------|---------|
| `get_notes` / `write_notes` | Scratchpad note-taking |
| `web_search` | Web search via SearXNG |
| `get_email_accounts` / `check_email` / `send_email` | Email integration (if configured) |

### Auto-Detection

Most tools auto-detect `project`, `repo`, and `branch` from the current git working directory. If auto-detection fails (e.g., running from a non-repo directory), pass these parameters explicitly.

## REST API

All endpoints except `/health` require a bearer token:

```bash
curl -H "Authorization: Bearer $OE_BRAIN_API_TOKEN" http://34.66.86.52:3000/api/tasks
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth) |
| POST | `/capture` | Capture a context entry (decision, learned, task, bookmark, etc.) |
| POST | `/ask` | Ask a question with LLM reasoning over your context |
| POST | `/api/search` | Semantic vector search |
| GET | `/api/tasks` | List tasks by status |
| GET | `/api/tasks/search?query=...` | Search tasks by keyword |
| GET | `/api/bookmarks` | List bookmarks by status |
| GET | `/api/bookmarks/search?query=...` | Search bookmarks |
| GET | `/api/context/branch/:branch` | Get branch context |
| GET | `/api/context/project/:project` | Get project context |
| GET | `/api/context/pr/:prNumber` | Get PR context |
| GET | `/api/entries/search?query=...` | Search entries by keyword and type |
| PATCH | `/api/entries/:id` | Update an entry |
| DELETE | `/api/entries/:id` | Delete an entry |
| GET | `/conversations` | List conversations |
| GET | `/conversations/:id/messages` | Get conversation messages |
| DELETE | `/conversations/:id` | Delete a conversation |

## Server Deployment (Kubernetes)

For operators managing the shared instance.

### Prerequisites

- GKE cluster with access to `oe-tesla-development-2`
- PostgreSQL with pgvector enabled (schema in `db/schema.sql`)
- Ollama running with `nomic-embed-text` model (for embeddings)
- OpenRouter API key (optional, for LLM-powered `/ask`)

### Build and Push

```bash
docker build -t gcr.io/oe-tesla-development-2/oe-brain:v1 .
docker push gcr.io/oe-tesla-development-2/oe-brain:v1
```

### Deploy with Helm

```bash
helm install oe-brain deploy/helm/oe-brain \
  --set secrets.databaseUrl="postgresql://user:pass@host:5432/oe_brain" \
  --set secrets.apiToken="<generate-a-token>" \
  --set secrets.openrouterApiKey="sk-or-..." \
  --set config.ollamaBaseUrl="http://ollama:11434"
```

To generate a token:

```bash
openssl rand -hex 32
```

### Verify

```bash
kubectl get pods -l app.kubernetes.io/name=oe-brain
curl http://<EXTERNAL-IP>:3000/health
```

### Helm Values

| Value | Default | Description |
|-------|---------|-------------|
| `replicaCount` | 1 | Number of replicas |
| `image.repository` | `gcr.io/oe-tesla-development-2/oe-brain` | Container image |
| `image.tag` | `v1` | Image tag |
| `config.ollamaBaseUrl` | `http://ollama:11434` | Ollama endpoint |
| `config.ollamaModel` | `nomic-embed-text` | Embedding model |
| `config.openrouter.model` | `google/gemini-2.5-flash` | LLM model for /ask |
| `secrets.databaseUrl` | — | PostgreSQL connection string |
| `secrets.apiToken` | — | Shared bearer token |
| `secrets.openrouterApiKey` | — | OpenRouter API key |
| `persistence.size` | `5Gi` | Vault PVC size |

## Local Development

### Prerequisites

- Node.js 20+
- PostgreSQL with pgvector (`db/schema.sql`)
- [Ollama](https://ollama.com) with `nomic-embed-text` model

### Config

Create `~/.oe-brain/config.yml` with direct database access:

```yaml
vault_path: ~/path/to/obsidian/vault
context_dir: context

database:
  connection_string: postgresql://localhost:5432/oe_brain

ollama:
  base_url: http://localhost:11434
  model: nomic-embed-text

server:
  port: 3000
  api_token: dev-token

projects:
  my-project:
    repos:
      my-repo: ~/Code/my-repo
```

### Run

```bash
npm run dev          # MCP server (hot reload)
npm run server       # HTTP API server (hot reload)
npm run test         # Run tests
npm run test:watch   # Watch mode
npm run build        # Compile TypeScript
```

## Project Structure

```
src/
  index.ts              # MCP server entry point
  cli.ts                # CLI entry point (hooks, sync)
  config.ts             # Config loader (YAML + env var interpolation)
  types.ts              # Shared types
  mcp/
    server.ts           # MCP server setup, tool registration
    tools/              # MCP tool handlers (search, capture, tasks, bookmarks, etc.)
  server/
    index.ts            # Fastify HTTP server
    plugins/auth.ts     # Bearer token auth
    routes/             # REST API routes
  services/
    database.ts         # PostgreSQL + pgvector (direct mode)
    api-client.ts       # API client services (client mode)
    embeddings.ts       # Ollama embedding calls
    vault.ts            # Obsidian vault read/write
    ask-pipeline.ts     # Intent → retrieval → LLM reasoning
    intent-router.ts    # Query intent classification
    conversation.ts     # Multi-turn conversation management
    git.ts              # Git context detection
    github.ts           # GitHub API (standup data)
  hooks/                # Claude Code hook handlers
```

## Data Storage

- **PostgreSQL + pgvector**: 768-dimension embeddings via Ollama `nomic-embed-text` for semantic search. Source of truth.
- **Obsidian vault** (server mode only): Human-readable markdown with YAML frontmatter, synced to iCloud. Can be rebuilt from database.
