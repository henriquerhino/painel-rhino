-- Migração v8 · Google Agenda (aplicada no projeto em 18/09/2026 como "v8_agenda")
create table if not exists public.calls (
  evento_id text primary key,
  mentorado_id uuid references public.mentorados(id) on delete cascade,
  titulo text,
  inicio timestamptz not null,
  fim timestamptz,
  contada_em timestamptz not null default now()
);
create index if not exists calls_mentorado_idx on public.calls (mentorado_id, inicio desc);
alter table public.calls enable row level security;
drop policy if exists acesso_logado on public.calls;
create policy acesso_logado on public.calls for all to authenticated using (true) with check (true);

create or replace function public.somar_call(p_mentorado uuid) returns int language sql security definer set search_path = public as $$
  update mentorados set calls_feitas = coalesce(calls_feitas,0) + 1 where id = p_mentorado returning calls_feitas;
$$;
revoke all on function public.somar_call(uuid) from public, anon, authenticated;

select cron.schedule('rhino-agenda-calls', '20 */3 * * *', $$select public.rhino_chamar('agenda', '{"acao":"contar_calls"}'::jsonb)$$);
