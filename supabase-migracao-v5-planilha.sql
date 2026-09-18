-- Migração v5 · integração com a planilha do Google
-- Rode uma vez no Supabase: SQL Editor -> New query -> cole -> Run.
-- Adiciona em `lancamentos` a origem do registro (painel ou planilha) e um
-- identificador estável por célula da planilha, para o painel sincronizar sem duplicar.

alter table public.lancamentos add column if not exists origem text;
alter table public.lancamentos add column if not exists origem_id text;

-- índice único: cada célula da planilha vira no máximo um lançamento
create unique index if not exists lancamentos_origem_id_key on public.lancamentos (origem_id);

-- consulta rápida do que veio da planilha
create index if not exists lancamentos_origem_idx on public.lancamentos (origem);
