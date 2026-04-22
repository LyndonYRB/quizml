create extension if not exists vector;

alter table public.study_material_chunks
  add column if not exists embedding vector(1536);

create index if not exists study_material_chunks_embedding_idx
on public.study_material_chunks
using hnsw (embedding vector_cosine_ops);

create or replace function public.match_study_material_chunks (
  query_embedding vector(1536),
  match_user_id uuid,
  match_material_ids uuid[],
  match_count int default 12
)
returns table (
  id uuid,
  study_material_id uuid,
  chunk_index int,
  content text,
  token_count int,
  similarity float
)
language sql stable as $$
  select
    c.id,
    c.study_material_id,
    c.chunk_index,
    c.content,
    c.token_count,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.study_material_chunks c
  where c.user_id = match_user_id
    and c.study_material_id = any(match_material_ids)
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_study_material_chunks(vector, uuid, uuid[], int)
  to authenticated;
