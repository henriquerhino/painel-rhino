-- Migração v6 · renovação e encerramento de contrato
-- Rode uma vez no Supabase: SQL Editor -> New query -> cole -> Run.
-- Liga o contrato novo ao anterior do mesmo mentorado (o histórico do anterior fica intacto)
-- e guarda a data em que o contrato foi encerrado, renovado ou cancelado.

alter table public.contratos add column if not exists renovacao_de uuid references public.contratos(id) on delete set null;
alter table public.contratos add column if not exists encerrado_em date;
create index if not exists contratos_renovacao_de_idx on public.contratos (renovacao_de);

-- (aplicada no projeto fcwxkelokmqwmivjembv em 18/09/2026 como migração "v6_renovacao_de_contrato")
