-- Run this in Supabase SQL Editor AFTER the first migration

-- Document chunks (RAG storage)
create table document_chunks (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references sessions(id) on delete cascade,
  material_id uuid references materials(id) on delete cascade,
  file_name text,
  chunk_index integer,
  chunk_text text,
  embedding text,  -- stored as JSON string for MVP; upgrade to pgvector for scale
  created_at timestamp default now()
);

-- Prompts log (track every prompt issued)
create table prompts_log (
  id uuid default gen_random_uuid() primary key,
  session_id uuid references sessions(id) on delete cascade,
  target text,
  prompt_text text,
  prompt_type text,
  issued_by text,  -- 'ai' or 'admin'
  created_at timestamp default now()
);

-- Add missing columns to existing tables
alter table sessions add column if not exists started_at timestamp;
alter table sessions add column if not exists ended_at timestamp;
alter table sessions add column if not exists report jsonb;

alter table scores add column if not exists speaker_tag text;

-- Index for faster chunk retrieval
create index if not exists idx_chunks_session on document_chunks(session_id);
create index if not exists idx_transcripts_session on transcripts(session_id);
create index if not exists idx_scores_session on scores(session_id);
