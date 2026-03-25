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
