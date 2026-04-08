-- Enable pgvector extension
create extension if not exists vector;

-- Context entries table
create table if not exists context_entries (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  type text not null,
  project text,
  repo text,
  branch text,
  pr_number int,
  title text not null,
  content text not null,
  embedding vector(768),
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  vault_path text unique
);

-- Indexes
create index if not exists idx_context_entries_user on context_entries (user_id);
create index if not exists idx_context_entries_project on context_entries (project);
create index if not exists idx_context_entries_repo on context_entries (repo);
create index if not exists idx_context_entries_branch on context_entries (branch);
create index if not exists idx_context_entries_pr on context_entries (pr_number);
create index if not exists idx_context_entries_type on context_entries (type);

-- Conversations table
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  user_id text,
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_conversations_user on conversations (user_id);

-- Messages table
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null,
  content text not null,
  metadata jsonb default '{}',
  created_at timestamptz default now()
);

create index if not exists idx_messages_conversation on messages (conversation_id);

-- Vector similarity search function
create or replace function match_context_entries(
  query_embedding vector(768),
  match_count int default 10,
  filter_project text default null,
  filter_repo text default null,
  filter_type text default null
)
returns table (
  id uuid,
  type text,
  project text,
  repo text,
  branch text,
  pr_number int,
  title text,
  content text,
  metadata jsonb,
  vault_path text,
  created_at timestamptz,
  updated_at timestamptz,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    ce.id,
    ce.type,
    ce.project,
    ce.repo,
    ce.branch,
    ce.pr_number,
    ce.title,
    ce.content,
    ce.metadata,
    ce.vault_path,
    ce.created_at,
    ce.updated_at,
    1 - (ce.embedding <=> query_embedding) as similarity
  from context_entries ce
  where
    ce.embedding is not null
    and (filter_project is null or ce.project = filter_project)
    and (filter_repo is null or ce.repo = filter_repo)
    and (filter_type is null or ce.type = filter_type)
  order by ce.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Conversations with preview function (replaces Supabase RPC)
create or replace function conversations_with_preview(row_limit int default 50)
returns table (
  id uuid,
  title text,
  created_at timestamptz,
  updated_at timestamptz,
  message_count bigint,
  last_message_preview text
)
language plpgsql
as $$
begin
  return query
  select
    c.id,
    c.title,
    c.created_at,
    c.updated_at,
    count(m.id) as message_count,
    (select left(m2.content, 100) from messages m2 where m2.conversation_id = c.id order by m2.created_at desc limit 1) as last_message_preview
  from conversations c
  left join messages m on m.conversation_id = c.id
  group by c.id
  order by c.updated_at desc
  limit row_limit;
end;
$$;

-- =============================================================================
-- Semantic Code Search (separate from context_entries — can be dropped cleanly)
-- =============================================================================

-- Code search entries table
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

create index if not exists idx_code_entries_embedding on code_entries
  using hnsw (embedding vector_cosine_ops);
create index if not exists idx_code_entries_tsv on code_entries using gin(tsv);
create index if not exists idx_code_entries_repo on code_entries (repo);
create index if not exists idx_code_entries_language on code_entries (language);
create index if not exists idx_code_entries_file_path on code_entries (repo, file_path);

-- Hybrid code search function using Reciprocal Rank Fusion (RRF)
-- Combines pgvector semantic similarity + pg full-text keyword ranking
create or replace function search_code(
  query_embedding vector(768),
  query_text text,
  match_count int default 10,
  filter_repo text default null,
  filter_language text default null,
  filter_symbol_type text default null
)
returns table (
  id uuid,
  repo text,
  file_path text,
  language text,
  symbol_name text,
  symbol_type text,
  line_start int,
  line_end int,
  content text,
  embed_text text,
  indexed_at timestamptz,
  score float
)
language plpgsql
as $$
begin
  return query
  with semantic as (
    select ce.id, row_number() over (order by ce.embedding <=> query_embedding) as rank
    from code_entries ce
    where ce.embedding is not null
      and (filter_repo is null or ce.repo = filter_repo)
      and (filter_language is null or ce.language = filter_language)
      and (filter_symbol_type is null or ce.symbol_type = filter_symbol_type)
    order by ce.embedding <=> query_embedding
    limit match_count * 3
  ),
  keyword as (
    select ce.id, row_number() over (order by ts_rank(ce.tsv, plainto_tsquery('english', query_text)) desc) as rank
    from code_entries ce
    where ce.tsv @@ plainto_tsquery('english', query_text)
      and (filter_repo is null or ce.repo = filter_repo)
      and (filter_language is null or ce.language = filter_language)
      and (filter_symbol_type is null or ce.symbol_type = filter_symbol_type)
    limit match_count * 3
  ),
  combined as (
    select
      coalesce(s.id, k.id) as id,
      coalesce(1.0 / (60 + s.rank), 0) + coalesce(1.0 / (60 + k.rank), 0) as rrf_score
    from semantic s
    full outer join keyword k on s.id = k.id
  )
  select
    ce.id,
    ce.repo,
    ce.file_path,
    ce.language,
    ce.symbol_name,
    ce.symbol_type,
    ce.line_start,
    ce.line_end,
    ce.content,
    ce.embed_text,
    ce.indexed_at,
    c.rrf_score as score
  from combined c
  join code_entries ce on ce.id = c.id
  order by c.rrf_score desc
  limit match_count;
end;
$$;
