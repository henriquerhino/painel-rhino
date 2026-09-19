-- Migração v7 · Pack Assessor Rhino
-- Cobrança com 1 toque, linha do tempo, fechamento mensal gravado e as tabelas do assessor.
-- Rode uma vez no Supabase: SQL Editor -> New query -> cole -> Run.
-- (aplicada no projeto fcwxkelokmqwmivjembv em 18/09/2026 como migração "v7_pack_assessor")

-- ---------- A6 · cobrança com 1 toque ----------
alter table public.mentorados add column if not exists whatsapp text;
alter table public.parcelas   add column if not exists cobrado_em date;
alter table public.config     add column if not exists pix_chave text;
alter table public.config     add column if not exists cobranca_modelo text;

-- ---------- B3 · linha do tempo ----------
create table if not exists public.eventos (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  origem text not null default 'painel',        -- painel | assessor | planilha | sistema
  tipo text not null,                            -- baixa, baixa_desfeita, renovacao, encerramento, cancelamento, reativacao, cobranca, planilha, fechamento…
  titulo text not null,
  detalhe jsonb,
  ref_tabela text,
  ref_id uuid,
  desfazer jsonb,                                -- o que o assessor precisa para desfazer a ação (24 h)
  desfeito_em timestamptz
);
create index if not exists eventos_criado_em_idx on public.eventos (criado_em desc);
alter table public.eventos enable row level security;
drop policy if exists acesso_logado on public.eventos;
create policy acesso_logado on public.eventos for all to authenticated using (true) with check (true);

-- ---------- B2 · fechamento mensal gravado ----------
create table if not exists public.fechamentos (
  ano_mes text primary key,                      -- '2026-08'
  fechado_em timestamptz not null default now(),
  recebido numeric not null default 0,
  fonte_receita text,                            -- planilha | painel
  despesas numeric not null default 0,
  resultado numeric not null default 0,
  margem numeric,
  meta numeric,
  por_grupo jsonb,                               -- despesas por matriz
  -- retrato do dia do fechamento (fica nulo quando o mês é gravado depois)
  mrr numeric, contratos_ativos int, vencido_valor numeric, vencido_qtd int,
  renovacoes int, nao_renovaram int, cancelamentos int
);
alter table public.fechamentos enable row level security;
drop policy if exists acesso_logado on public.fechamentos;
create policy acesso_logado on public.fechamentos for all to authenticated using (true) with check (true);

create or replace function public.gravar_fechamento(p_ano_mes text default null, p_retrato boolean default true)
returns public.fechamentos language plpgsql security definer set search_path = public as $$
declare
  v_ini date; v_fim date; v_am text; v_planilha boolean; r public.fechamentos;
begin
  v_ini := coalesce(to_date(p_ano_mes || '-01','YYYY-MM-DD'),
                    (date_trunc('month', (now() at time zone 'America/Sao_Paulo')) - interval '1 month')::date);
  v_fim := (v_ini + interval '1 month')::date;
  v_am  := to_char(v_ini,'YYYY-MM');
  v_planilha := exists(select 1 from lancamentos where origem='planilha' and tipo='entrada' and data>=v_ini and data<v_fim);

  r.ano_mes := v_am; r.fechado_em := now();
  r.fonte_receita := case when v_planilha then 'planilha' else 'painel' end;
  r.recebido := coalesce((select sum(valor) from lancamentos where tipo='entrada' and pago and data>=v_ini and data<v_fim),0)
    + case when v_planilha then 0 else coalesce((select sum(p.valor) from parcelas p join contratos c on c.id=p.contrato_id
        where p.pago and coalesce(p.data_pagamento,p.vencimento)>=v_ini and coalesce(p.data_pagamento,p.vencimento)<v_fim),0) end;
  r.despesas := coalesce((select sum(valor) from lancamentos where tipo='despesa' and data>=v_ini and data<v_fim),0);
  r.resultado := r.recebido - r.despesas;
  r.margem := case when r.recebido>0 then round(r.resultado/r.recebido*100,1) end;
  r.meta := coalesce((select total from metas_mes where ano_mes=v_am),(select meta_mensal from config where id=1));
  r.por_grupo := (select jsonb_object_agg(g, t) from (
      select coalesce(case when c.matriz then c.nome else pai.nome end,'Sem categoria') g, round(sum(l.valor),2) t
      from lancamentos l left join categorias c on c.nome=l.categoria left join categorias pai on pai.id=c.parent_id
      where l.tipo='despesa' and l.data>=v_ini and l.data<v_fim group by 1) x);
  if p_retrato then
    r.mrr := (select round(sum(valor_total/greatest(meses,1)),2) from contratos where status='ativo');
    r.contratos_ativos := (select count(*) from contratos where status='ativo');
    select coalesce(sum(p.valor),0), count(*) into r.vencido_valor, r.vencido_qtd
      from parcelas p join contratos c on c.id=p.contrato_id where not p.pago and p.vencimento<v_fim and c.status<>'cancelado';
    r.renovacoes    := (select count(*) from contratos where renovacao_de is not null and data_inicio>=v_ini and data_inicio<v_fim);
    r.nao_renovaram := (select count(*) from contratos where status='concluido' and encerrado_em>=v_ini and encerrado_em<v_fim);
    r.cancelamentos := (select count(*) from contratos where status='cancelado' and encerrado_em>=v_ini and encerrado_em<v_fim);
  end if;

  insert into fechamentos select r.* on conflict (ano_mes) do update set
    fechado_em=excluded.fechado_em, recebido=excluded.recebido, fonte_receita=excluded.fonte_receita, despesas=excluded.despesas,
    resultado=excluded.resultado, margem=excluded.margem, meta=excluded.meta, por_grupo=excluded.por_grupo,
    mrr=coalesce(excluded.mrr,fechamentos.mrr), contratos_ativos=coalesce(excluded.contratos_ativos,fechamentos.contratos_ativos),
    vencido_valor=coalesce(excluded.vencido_valor,fechamentos.vencido_valor), vencido_qtd=coalesce(excluded.vencido_qtd,fechamentos.vencido_qtd),
    renovacoes=coalesce(excluded.renovacoes,fechamentos.renovacoes), nao_renovaram=coalesce(excluded.nao_renovaram,fechamentos.nao_renovaram),
    cancelamentos=coalesce(excluded.cancelamentos,fechamentos.cancelamentos);
  insert into eventos(origem,tipo,titulo,detalhe) values ('sistema','fechamento','Fechamento de '||v_am||' gravado',
    jsonb_build_object('recebido',r.recebido,'despesas',r.despesas,'resultado',r.resultado));
  return r;
end $$;
revoke all on function public.gravar_fechamento(text,boolean) from public, anon;
grant execute on function public.gravar_fechamento(text,boolean) to authenticated, service_role;

-- ---------- C · assessor no celular ----------
create table if not exists public.assessor_contatos (     -- quem o assessor atende
  telefone text primary key,                               -- só dígitos, com DDI: 5511999999999
  nome text not null,
  papel text not null default 'dono',                      -- dono | equipe
  ativo boolean not null default true,
  recebe_relatorios boolean not null default true,
  ultimo_contato timestamptz,                              -- última mensagem recebida (janela de 24 h do WhatsApp)
  prefs jsonb not null default '{}'::jsonb                 -- como chamar, horário do resumo, tom…
);
create table if not exists public.assessor_mensagens (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  telefone text not null,
  direcao text not null check (direcao in ('in','out')),
  tipo text not null default 'text',
  texto text,
  wa_id text unique,                                       -- id da mensagem no WhatsApp (evita processar duas vezes)
  meta jsonb
);
create index if not exists assessor_mensagens_tel_idx on public.assessor_mensagens (telefone, criado_em desc);
create table if not exists public.assessor_pendentes (      -- ações propostas esperando o "sim"
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  telefone text not null,
  acao jsonb not null,
  resumo text not null,
  estado text not null default 'pendente' check (estado in ('pendente','confirmada','cancelada','expirada')),
  resolvido_em timestamptz
);
create table if not exists public.assessor_segredos (chave text primary key, valor text not null); -- só o servidor lê
alter table public.assessor_contatos  enable row level security;
alter table public.assessor_mensagens enable row level security;
alter table public.assessor_pendentes enable row level security;
alter table public.assessor_segredos  enable row level security;   -- sem política: nem usuário logado enxerga
drop policy if exists acesso_logado on public.assessor_contatos;
drop policy if exists acesso_logado on public.assessor_mensagens;
drop policy if exists acesso_logado on public.assessor_pendentes;
create policy acesso_logado on public.assessor_contatos  for all to authenticated using (true) with check (true);
create policy acesso_logado on public.assessor_mensagens for select to authenticated using (true);
create policy acesso_logado on public.assessor_pendentes for select to authenticated using (true);
insert into public.assessor_segredos(chave,valor) values ('cron', replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''))
  on conflict (chave) do nothing;

-- ---------- agendador (aplicado como v7b, v7c e v7d) ----------
-- Precisa das extensões pg_cron e pg_net (Database -> Extensions no Supabase).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- chama uma Edge Function do projeto com o segredo interno (só o banco usa)
create or replace function public.rhino_chamar(p_funcao text, p_corpo jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public, extensions, net as $$
declare v_seg text; v_id bigint;
begin
  select valor into v_seg from public.assessor_segredos where chave='cron';
  select net.http_post(
    url := 'https://fcwxkelokmqwmivjembv.supabase.co/functions/v1/' || p_funcao,
    headers := jsonb_build_object('Content-Type','application/json','x-rhino-cron',v_seg),
    body := p_corpo, timeout_milliseconds := 60000) into v_id;
  return v_id;
end $$;
revoke all on function public.rhino_chamar(text,jsonb) from public, anon, authenticated;
revoke execute on function public.gravar_fechamento(text, boolean) from authenticated;

-- horários em UTC (São Paulo = UTC-3)
select cron.schedule('rhino-planilha-horaria',  '7 * * * *',    $$select public.rhino_chamar('planilha')$$);
select cron.schedule('rhino-fechamento-mensal', '10 9 1 * *',   $$select public.gravar_fechamento()$$);
select cron.schedule('rhino-assessor-bom-dia',  '30 10 * * 1-6', $$select public.rhino_chamar('assessor', '{"rotina":"bom_dia"}'::jsonb)$$); -- 07:30 seg a sáb
select cron.schedule('rhino-assessor-semana',   '0 21 * * 5',   $$select public.rhino_chamar('assessor', '{"rotina":"semana"}'::jsonb)$$);  -- sexta 18:00
select cron.schedule('rhino-assessor-mes',      '40 10 1 * *',  $$select public.rhino_chamar('assessor', '{"rotina":"mes"}'::jsonb)$$);     -- dia 1, 07:40
select cron.schedule('rhino-limpa-http',        '15 6 * * *',   $$delete from net._http_response where created < now() - interval '7 days'$$);

-- a tabela de backup dos lançamentos manuais fica fechada (só o servidor lê)
alter table if exists public.lancamentos_backup_20260918 enable row level security;
