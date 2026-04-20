# Semantic Code Search for oe-brain

## Problem

Grep-based code search is literal — it finds exact string matches but can't understand meaning. When searching large codebases (tesla-site: 2,200 Ruby files, core-ui: 1,700 TypeScript files), developers need to know exact naming conventions and file locations. Semantic search bridges this gap by finding conceptually related code regardless of naming.

## Solution

Add semantic code search to the existing oe-brain MCP server and CLI. Uses the existing pgvector + Ollama infrastructure — no new external services.

### Architecture

```
oe-brain index-code <repo-path>     # CLI: index a codebase
     │
     ▼
┌─────────────────────────┐
│  CodeIndexer service     │
│  - walk files (.gitignore│
│    aware)                │
│  - tree-sitter AST parse │
│  - extract symbols       │
│  - enrich with structural│
│    context for embedding │
│  - embed via Ollama      │
│  - upsert to code_entries│
└─────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────┐
│  code_entries table (NEW, separate table)    │
│  - symbol_name, symbol_type, file_path      │
│  - content (raw code)                       │
│  - embed_text (enriched natural language)    │
│  - embedding vector(768) for semantic search │
│  - tsvector for keyword search              │
│  - file_hash for incremental indexing       │
└─────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────┐
│  search_code MCP tool    │
│  (alongside search_context)│
│  - hybrid: pgvector +   │
│    tsvector via RRF      │
│  - filter by repo, lang,│
│    symbol_type           │
└─────────────────────────┘
```

## Database Schema

New table, completely independent from `context_entries`. Can be dropped without affecting any existing data.

```sql
create table if not exists code_entries (
  id          uuid primary key default gen_random_uuid(),
  repo        text not null,
  file_path   text not null,
  language    text,
  symbol_name text,
  symbol_type text,
  line_start  int,
  line_end    int,
  content     text not null,
  embed_text  text not null,
  embedding   vector(768),
  tsv         tsvector generated always as (to_tsvector('english', embed_text)) stored,
  file_hash   text,
  indexed_at  timestamptz default now(),
  unique(repo, file_path, symbol_name, line_start)
);

create index idx_code_entries_embedding on code_entries
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index idx_code_entries_tsv on code_entries using gin(tsv);
create index idx_code_entries_repo on code_entries (repo);
create index idx_code_entries_language on code_entries (language);
```

## Hybrid Search Function

Reciprocal Rank Fusion combining vector similarity + keyword matching:

```sql
create or replace function search_code(
  query_embedding vector(768),
  query_text text,
  match_count int default 10,
  filter_repo text default null,
  filter_language text default null,
  filter_symbol_type text default null
)
```

## Chunking Strategy: tree-sitter

AST-aware symbol extraction, not naive line-based chunking.

**Ruby:** classes, modules, methods + YARD docs
**TypeScript/TSX:** functions, classes, interfaces, React components, hooks

Each symbol gets an enriched `embed_text`:
```
Ruby method app/services/tags_v2/data_mapper.rb
DataMapper#map_entity_to_tags
Maps entity properties and metadata to V2 tag format for persistence.
def map_entity_to_tags(entity, tag_types)
```

Files without clear symbols get ~100-line sliding window chunks with overlap.

## MCP Tool

`search_code` — registered alongside existing `search_context` in oe-brain MCP server.

Parameters: query, repo, language, symbol_type, limit

## CLI Commands

```bash
oe-brain index-code <repo-path>          # full index
oe-brain index-code --incremental        # only changed files
oe-brain index-code --status             # show index stats
oe-brain index-code --drop <repo>        # remove a repo's entries
```

## Post-commit Hook

Extends existing `post-commit` hook to re-index changed files.

## Storage Estimate

~20,000 entries × ~4KB each = ~80-100MB total. Trivial for Postgres.

## New Dependencies

- `web-tree-sitter` (WASM-based, no native compilation — works on all platforms with just `npm install`)
- WASM grammar files bundled in `src/grammars/` (~600KB total): `tree-sitter-ruby.wasm`, `tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`

## Cleanup

```sql
DROP TABLE code_entries;
DROP FUNCTION search_code;
```
Delete `src/services/code-indexer.ts` and `src/mcp/tools/code-search.ts`.

## Not In Scope

- AI-generated summaries (structural enrichment only)
- Obsidian vault integration
- File watcher (commit hook + manual index is sufficient)
