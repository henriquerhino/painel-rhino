// ============================================================
// PAINEL RHINO · Edge Function "assessor"
// O assessor no WhatsApp (API oficial da Meta): responde perguntas com os números
// do painel, propõe ações (sempre com confirmação e Desfazer por 24 h) e manda os
// relatórios automáticos.
//
// Segredos (Supabase → Edge Functions → Secrets), colados pelo dono do projeto:
//   ANTHROPIC_API_KEY        já existe (é a mesma da função "agente")
//   WHATSAPP_TOKEN           token permanente do usuário de sistema (Meta Business)
//   WHATSAPP_PHONE_ID        "Phone number ID" do número do assessor
//   WHATSAPP_APP_SECRET      "App secret" do app na Meta (assina o webhook)
//   WHATSAPP_VERIFY_TOKEN    uma frase qualquer, repetida na tela do webhook da Meta
//   GROQ_API_KEY ou OPENAI_API_KEY   (opcional) para transcrever áudios
//   WHATSAPP_TEMPLATE_RESUMO (opcional) nome do modelo aprovado; padrão "resumo_pronto"
//
// Só números cadastrados em assessor_contatos (Configurações do painel) são atendidos.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Reg = Record<string, any>;
const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
// O id do número e a frase de verificação do webhook não são segredo de verdade: podem vir da tabela
// assessor_segredos (só o servidor lê). O token e a chave secreta do app continuam só nos Secrets.
const CFG: Reg = {}; let cfgEm = 0;
async function carregarCfg() { if (Date.now() - cfgEm < 60000) return; const { data } = await sb.from("assessor_segredos").select("chave,valor").in("chave", ["whatsapp_phone_id", "whatsapp_verify_token"]); for (const r of data || []) CFG[r.chave] = r.valor; cfgEm = Date.now(); }
const cfg = (k: string) => env(k) || CFG[k.toLowerCase()] || "";
const GRAPH = `https://graph.facebook.com/${env("WHATSAPP_GRAPH_VERSION") || "v22.0"}`;
const MODELO = env("ASSESSOR_MODELO") || "claude-sonnet-5";
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const rs = (v: unknown) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rsc = (v: unknown) => "R$ " + Math.round(Number(v) || 0).toLocaleString("pt-BR");
const dbr = (s: unknown) => { const [y, m, d] = String(s).slice(0, 10).split("-"); return `${d}/${m}/${y.slice(2)}`; };
const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const pad = (n: number) => String(n).padStart(2, "0");

/** Hoje em São Paulo (UTC−3). */
function hojeSP() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  const ano = d.getUTCFullYear(), mes = d.getUTCMonth(), dia = d.getUTCDate();
  return { ano, mes, dia, sem: d.getUTCDay(), iso: `${ano}-${pad(mes + 1)}-${pad(dia)}`, hora: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
}
const diasAte = (iso: unknown) => Math.round((Date.parse(String(iso).slice(0, 10)) - Date.parse(hojeSP().iso)) / 86400000);
const noMes = (s: unknown, a: number, m: number) => !!s && String(s).slice(0, 7) === `${a}-${pad(m + 1)}`;
const somaIso = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86400000).toISOString().slice(0, 10);
/** 5511 9xxxx-xxxx e 5511 xxxx-xxxx são o mesmo WhatsApp: compara sem o nono dígito. */
const canon = (t: string) => { const d = String(t).replace(/\D/g, ""); return d.length === 13 && d.startsWith("55") && d[4] === "9" ? d.slice(0, 4) + d.slice(5) : d; };

// ------------------------------------------------------------------ dados
async function carregar(): Promise<Reg> {
  const H = hojeSP(), desde = `${H.ano - 1}-${pad(H.mes + 1)}-01`;
  const t = ["config","produtos","mentorados","contratos","parcelas","recorrencias","cartoes","parcelamentos","assinaturas","metas_mes","categorias"];
  const r = await Promise.all([...t.map((x) => sb.from(x).select("*").range(0, 4999)), sb.from("lancamentos").select("*").gte("data", desde).range(0, 9999)]);
  const D: Reg = {}; t.forEach((x, i) => D[x] = r[i].data || []); D.lancamentos = r[t.length].data || [];
  D.config = D.config[0] || {};
  return D;
}
const nomeProd = (D: Reg, id: string) => D.produtos.find((p: Reg) => p.id === id)?.nome || "Sem produto";
const mentoradoDe = (D: Reg, c: Reg) => D.mentorados.find((m: Reg) => m.id === c?.mentorado_id);
function matrizDe(D: Reg, cat: string) { const c = D.categorias.find((x: Reg) => x.nome === cat); if (!c) return "Sem categoria"; return c.matriz ? c.nome : (D.categorias.find((x: Reg) => x.id === c.parent_id)?.nome || c.nome); }
function caixaMes(D: Reg, a: number, m: number) {
  const planilha = D.lancamentos.some((l: Reg) => l.origem === "planilha" && l.tipo === "entrada" && noMes(l.data, a, m));
  let total = 0; const pp: Reg = {};
  if (!planilha) for (const p of D.parcelas) if (p.pago && noMes(p.data_pagamento || p.vencimento, a, m)) { const c = D.contratos.find((x: Reg) => x.id === p.contrato_id); if (!c) continue; total += +p.valor; const k = nomeProd(D, c.produto_id); pp[k] = (pp[k] || 0) + +p.valor; }
  for (const l of D.lancamentos) if (l.tipo === "entrada" && l.pago && noMes(l.data, a, m)) { total += +l.valor; const k = nomeProd(D, l.produto_id); pp[k] = (pp[k] || 0) + +l.valor; }
  return { total, pp, planilha };
}
function despesasMes(D: Reg, a: number, m: number) {
  const L = D.lancamentos.filter((l: Reg) => l.tipo === "despesa" && noMes(l.data, a, m)); const grupos: Reg = {};
  for (const l of L) { const g = matrizDe(D, l.categoria); grupos[g] = (grupos[g] || 0) + +l.valor; }
  const soma = (f: (l: Reg) => boolean) => L.filter(f).reduce((s: number, l: Reg) => s + +l.valor, 0);
  return { total: soma(() => true), pago: soma((l) => l.pago), aPagar: soma((l) => !l.pago), grupos, itens: L };
}
function abertas(D: Reg) {
  return D.parcelas.filter((p: Reg) => !p.pago).map((p: Reg) => { const c = D.contratos.find((x: Reg) => x.id === p.contrato_id); return { ...p, contrato: c, mentorado: c ? mentoradoDe(D, c) : null, d: diasAte(p.vencimento) }; })
    .filter((p: Reg) => p.contrato && p.contrato.status !== "cancelado" && p.mentorado).sort((a: Reg, b: Reg) => String(a.vencimento).localeCompare(String(b.vencimento)));
}
function metaDoMes(D: Reg, a: number, m: number) { const r = D.metas_mes.find((x: Reg) => x.ano_mes === `${a}-${pad(m + 1)}`); return r ? +r.total : (+D.config.meta_mensal || 0); }
function semanaAtual(D: Reg) {
  const H = hojeSP(), ult = new Date(Date.UTC(H.ano, H.mes + 1, 0)).getUTCDate(), ini = Math.floor((H.dia - 1) / 7) * 7 + 1, fim = Math.min(ini + 6, ult);
  const meta = metaDoMes(D, H.ano, H.mes), cx = caixaMes(D, H.ano, H.mes), reg = D.metas_mes.find((x: Reg) => x.ano_mes === `${H.ano}-${pad(H.mes + 1)}`);
  const n = Math.floor((ini - 1) / 7) + 1, fixa = reg?.[`s${n}`];
  const alvo = fixa != null && fixa !== "" ? +fixa : meta * (fim - ini + 1) / ult;
  const noDia = (s: unknown) => { const d = +String(s).slice(8, 10); return d >= ini && d <= fim; };
  let datado = 0, foraDaSemana = 0;
  for (const p of D.parcelas) if (p.pago && noMes(p.data_pagamento || p.vencimento, H.ano, H.mes)) (noDia(p.data_pagamento || p.vencimento) ? (datado += +p.valor) : (foraDaSemana += +p.valor));
  for (const l of D.lancamentos) if (l.tipo === "entrada" && l.pago && l.origem !== "planilha" && noMes(l.data, H.ano, H.mes)) (noDia(l.data) ? (datado += +l.valor) : (foraDaSemana += +l.valor));
  // com a planilha, o que as baixas não explicam entra na semana atual (mesma regra do painel)
  const valor = cx.planilha ? Math.max(0, Math.min(cx.total, cx.total - foraDaSemana)) : datado;
  return { n, de: ini, ate: fim, valor, alvo, pct: alvo ? valor / alvo * 100 : 0, meta, recebidoMes: cx.total };
}
function faturaCartao(D: Reg, id: string, a: number, m: number) {
  let t = 0;
  for (const p of D.parcelamentos) if (p.cartao_id === id) { const [y, mm] = String(p.primeira_competencia).split("-").map(Number); const n = (a - y) * 12 + (m + 1 - mm); if (n >= 0 && n < p.total_parcelas) t += +p.valor_parcela; }
  for (const x of D.assinaturas) if (x.cartao_id === id && x.ativo !== false) t += +x.valor;
  return t;
}
function resumoMes(D: Reg, a: number, m: number) {
  const H = hojeSP(), cx = caixaMes(D, a, m), dp = despesasMes(D, a, m), meta = metaDoMes(D, a, m);
  const ant = new Date(Date.UTC(a, m - 1, 1)), cxA = caixaMes(D, ant.getUTCFullYear(), ant.getUTCMonth()), dpA = despesasMes(D, ant.getUTCFullYear(), ant.getUTCMonth());
  const atual = a === H.ano && m === H.mes, faltaEntrar = atual ? abertas(D).filter((p: Reg) => noMes(p.vencimento, a, m)).reduce((s: number, p: Reg) => s + +p.valor, 0) : 0;
  return { mes: `${MESES[m]} de ${a}`, em_andamento: atual, recebido: +cx.total.toFixed(2), fonte_da_receita: cx.planilha ? "planilha" : "parcelas baixadas no painel", recebido_por_produto: cx.pp,
    despesas_total: +dp.total.toFixed(2), despesas_pagas: +dp.pago.toFixed(2), despesas_a_pagar: +dp.aPagar.toFixed(2), despesas_por_grupo: dp.grupos,
    resultado: +(cx.total - dp.total).toFixed(2), margem_pct: cx.total ? +((cx.total - dp.total) / cx.total * 100).toFixed(1) : null,
    meta, pct_da_meta: meta ? +(cx.total / meta * 100).toFixed(0) : null, semana_atual: atual ? semanaAtual(D) : null,
    parcelas_em_aberto_com_vencimento_no_mes: +faltaEntrar.toFixed(2), saldo_projetado: atual ? +(cx.total + faltaEntrar - dp.total).toFixed(2) : null,
    mes_anterior: { mes: MESES[ant.getUTCMonth()], recebido: +cxA.total.toFixed(2), despesas: +dpA.total.toFixed(2), resultado: +(cxA.total - dpA.total).toFixed(2) } };
}

// ------------------------------------------------------------------ Google Agenda (pela função "agenda")
async function agenda(corpo: Reg): Promise<Reg> {
  const { data: seg } = await sb.from("assessor_segredos").select("valor").eq("chave", "cron").maybeSingle();
  const r = await fetch(`${env("SUPABASE_URL")}/functions/v1/agenda`, { method: "POST", headers: { "Content-Type": "application/json", "x-rhino-cron": seg?.valor || "" }, body: JSON.stringify(corpo) });
  const j = await r.json(); if (j.erro) throw new Error(j.erro); return j;
}
async function agendaLigada() { const { data } = await sb.from("assessor_segredos").select("chave").eq("chave", "google_url").maybeSingle(); return !!data; }
const msSP = (local: string) => Date.parse(String(local).slice(0, 16) + ":00-03:00");            // "2026-09-24T16:00" (São Paulo) -> instante
const localSP = (ms: number) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 16);         // instante -> "2026-09-24T16:00"
async function acharEvento(id: string): Promise<Reg | null> {
  const H = hojeSP(), r = await agenda({ acao: "listar", de: `${somaIso(H.iso, -2)}T00:00:00`, ate: `${somaIso(H.iso, 90)}T23:59:59` });
  return (r.eventos || []).find((e: Reg) => e.id === id) || null;
}

// ------------------------------------------------------------------ ferramentas do Claude
const TOOLS = [
  { name: "resumo_mes", description: "Números de um mês: recebido (a planilha é a fonte), despesas, resultado, margem, meta, semana atual, saldo projetado e o mês anterior para comparar. Sem parâmetros = mês atual.", input_schema: { type: "object", properties: { ano: { type: "integer" }, mes: { type: "integer", description: "1 a 12" } } } },
  { name: "recebiveis", description: "Parcelas em aberto dos mentorados. Traz parcela_id (necessário para dar baixa), nome, número, valor, vencimento, dias de atraso e a data da última cobrança.", input_schema: { type: "object", properties: { filtro: { type: "string", enum: ["vencidas", "proximos_30", "todas"] }, nome: { type: "string", description: "parte do nome do mentorado" } }, required: ["filtro"] } },
  { name: "contratos", description: "Contratos dos mentorados com valor, recebido, saldo, fim, situação e calls. Traz contrato_id.", input_schema: { type: "object", properties: { filtro: { type: "string", enum: ["ativos", "vencidos", "vencendo_30", "renovados", "nao_renovaram", "cancelados", "todos"] }, nome: { type: "string" } }, required: ["filtro"] } },
  { name: "despesas", description: "Despesas de um mês (sem parâmetros = mês atual). Traz lancamento_id, descrição, categoria, grupo, valor, vencimento e se está paga.", input_schema: { type: "object", properties: { ano: { type: "integer" }, mes: { type: "integer" }, filtro: { type: "string", enum: ["a_pagar", "pagas", "todas"] }, busca: { type: "string" } } } },
  { name: "cartoes", description: "Fatura projetada de cada cartão no mês atual e o total já comprometido nos próximos 6 meses.", input_schema: { type: "object", properties: {} } },
  { name: "agenda", description: "Google Agenda do dono. acao=listar traz os compromissos entre duas datas (sem datas = hoje) com evento_id, horário, link do Meet e o mentorado ligado ao evento. acao=livre traz os horários livres de um dia, entre 08:00 e 20:00.", input_schema: { type: "object", properties: { acao: { type: "string", enum: ["listar", "livre"] }, de: { type: "string", description: "AAAA-MM-DD" }, ate: { type: "string", description: "AAAA-MM-DD" }, dia: { type: "string", description: "AAAA-MM-DD" }, duracao_min: { type: "integer" } }, required: ["acao"] } },
  { name: "linha_do_tempo", description: "O que aconteceu nos últimos dias: baixas, renovações, cobranças, mudanças vindas da planilha.", input_schema: { type: "object", properties: { dias: { type: "integer" } } } },
  { name: "propor_acao", description: "Única forma de alterar dados. NÃO grava nada: registra a proposta, e o sistema pede a confirmação do usuário com botões. Use os ids vindos das outras ferramentas. Depois de chamar, diga em uma frase o que vai ser feito e peça a confirmação; nunca diga que já foi feito.",
    input_schema: { type: "object", properties: {
      tipo: { type: "string", enum: ["baixar_parcela", "desfazer_baixa", "lancar_despesa", "marcar_despesa_paga", "encerrar_contrato", "renovar_contrato", "criar_reuniao", "remarcar_reuniao", "cancelar_reuniao"] },
      titulo: { type: "string" }, inicio: { type: "string", description: "AAAA-MM-DDTHH:MM no horário de São Paulo" }, duracao_min: { type: "integer", description: "padrão 60" }, mentorado_id: { type: "string", description: "quando a reunião é com um mentorado (vem da ferramenta contratos)" }, convidados: { type: "array", items: { type: "string" }, description: "e-mails para convidar" }, meet: { type: "boolean", description: "padrão true" }, evento_id: { type: "string" },
      parcela_id: { type: "string" }, data: { type: "string", description: "AAAA-MM-DD; padrão hoje" }, valor: { type: "number", description: "baixa parcial ou valor da despesa" },
      lancamento_id: { type: "string" }, pago: { type: "boolean" }, descricao: { type: "string" }, categoria: { type: "string", description: "nome exato de uma categoria de despesa do painel" },
      contrato_id: { type: "string" }, situacao: { type: "string", enum: ["nao_renovou", "cancelou"] },
      valor_total: { type: "number" }, entrada: { type: "number" }, meses: { type: "integer" }, parcelas: { type: "integer" }, data_inicio: { type: "string" } }, required: ["tipo"] } },
];

async function usarFerramenta(D: Reg, contato: Reg, nome: string, inp: Reg): Promise<unknown> {
  const H = hojeSP();
  if (nome === "resumo_mes") return resumoMes(D, inp.ano || H.ano, inp.mes ? inp.mes - 1 : H.mes);
  if (nome === "recebiveis") {
    const q = norm(inp.nome); let L = abertas(D).filter((p: Reg) => !q || norm(p.mentorado.nome).includes(q));
    if (inp.filtro === "vencidas") L = L.filter((p: Reg) => p.d < 0); if (inp.filtro === "proximos_30") L = L.filter((p: Reg) => p.d >= 0 && p.d <= 30);
    return { total: +L.reduce((s: number, p: Reg) => s + +p.valor, 0).toFixed(2), quantidade: L.length, observacao: "Dar baixa não muda o faturamento dos meses que vêm da planilha.",
      parcelas: L.slice(0, 40).map((p: Reg) => ({ parcela_id: p.id, mentorado: p.mentorado.nome, produto: nomeProd(D, p.contrato.produto_id), numero: p.numero, valor: +p.valor, vencimento: p.vencimento, dias_de_atraso: p.d < 0 ? -p.d : 0, cobrado_em: p.cobrado_em || null })) };
  }
  if (nome === "contratos") {
    const q = norm(inp.nome), f = inp.filtro;
    const L = D.contratos.map((c: Reg) => { const m = mentoradoDe(D, c); if (!m) return null; const ps = D.parcelas.filter((p: Reg) => p.contrato_id === c.id), rec = ps.filter((p: Reg) => p.pago).reduce((s: number, p: Reg) => s + +p.valor, 0);
      return { contrato_id: c.id, mentorado_id: m.id, mentorado: m.nome, produto: nomeProd(D, c.produto_id), situacao: c.status, valor_total: +c.valor_total, recebido: +rec.toFixed(2), saldo: +Math.max(0, +c.valor_total - rec).toFixed(2), inicio: c.data_inicio, fim: c.data_fim, dias_para_o_fim: diasAte(c.data_fim), calls: `${m.calls_feitas || 0}/${m.calls_contratadas || 0}`, e_renovacao: !!c.renovacao_de }; })
      .filter((x: Reg | null): x is Reg => !!x).filter((x: Reg) => !q || norm(x.mentorado).includes(q))
      .filter((x: Reg) => f === "todos" ? true : f === "ativos" ? x.situacao === "ativo" : f === "vencidos" ? x.situacao === "ativo" && x.dias_para_o_fim < 0 : f === "vencendo_30" ? x.situacao === "ativo" && x.dias_para_o_fim >= 0 && x.dias_para_o_fim <= 30 : f === "renovados" ? x.situacao === "renovado" : f === "nao_renovaram" ? x.situacao === "concluido" : x.situacao === "cancelado");
    return { quantidade: L.length, contratos: L.sort((a: Reg, b: Reg) => a.dias_para_o_fim - b.dias_para_o_fim).slice(0, 40) };
  }
  if (nome === "despesas") {
    const a = inp.ano || H.ano, m = inp.mes ? inp.mes - 1 : H.mes, q = norm(inp.busca), dp = despesasMes(D, a, m);
    const L = dp.itens.filter((l: Reg) => inp.filtro === "a_pagar" ? !l.pago : inp.filtro === "pagas" ? l.pago : true).filter((l: Reg) => !q || norm(`${l.descricao} ${l.categoria}`).includes(q)).sort((x: Reg, y: Reg) => String(x.data).localeCompare(String(y.data)));
    return { mes: `${MESES[m]} de ${a}`, total_do_mes: +dp.total.toFixed(2), a_pagar: +dp.aPagar.toFixed(2), por_grupo: dp.grupos, categorias_validas: D.categorias.filter((c: Reg) => c.tipo === "despesa").map((c: Reg) => c.nome),
      despesas: L.slice(0, 50).map((l: Reg) => ({ lancamento_id: l.id, descricao: l.descricao || l.categoria, categoria: l.categoria, grupo: matrizDe(D, l.categoria), valor: +l.valor, vencimento: l.data, paga: !!l.pago, veio_da_planilha: l.origem === "planilha" })) };
  }
  if (nome === "cartoes") {
    const meses = [0, 1, 2, 3, 4, 5].map((i) => { const d = new Date(Date.UTC(H.ano, H.mes + i, 1)); return { mes: `${MESES[d.getUTCMonth()]}/${d.getUTCFullYear()}`, total: +D.cartoes.reduce((s: number, c: Reg) => s + faturaCartao(D, c.id, d.getUTCFullYear(), d.getUTCMonth()), 0).toFixed(2) }; });
    return { cartoes: D.cartoes.map((c: Reg) => ({ nome: c.nome, vence_dia: c.dia_vencimento, fatura_do_mes: +faturaCartao(D, c.id, H.ano, H.mes).toFixed(2) })).filter((c: Reg) => c.fatura_do_mes > 0), comprometido_por_mes: meses, observacao: "As faturas efetivas do mês aparecem nas despesas (grupo Cartões), vindas da planilha." };
  }
  if (nome === "agenda") {
    if (!(await agendaLigada())) return { erro: "O Google Agenda ainda não está conectado. A conexão é feita no painel, aba Agenda." };
    if (inp.acao === "livre") return await agenda({ acao: "livre", dia: inp.dia || H.iso, duracao_min: inp.duracao_min || 60 });
    const de = inp.de || inp.dia || H.iso, ate = inp.ate || de, r = await agenda({ acao: "listar", de: `${de}T00:00:00`, ate: `${ate}T23:59:59` });
    return { de, ate, eventos: (r.eventos || []).map((e: Reg) => ({ evento_id: e.id, titulo: e.titulo, inicio: e.inicio, fim: e.fim, dia_inteiro: e.dia_inteiro, meet: e.meet || null, mentorado: e.mentorado?.nome || null, calls_do_mentorado: e.mentorado?.calls || null })) };
  }
  if (nome === "linha_do_tempo") { const { data } = await sb.from("eventos").select("criado_em,origem,tipo,titulo").gte("criado_em", new Date(Date.now() - (inp.dias || 3) * 86400000).toISOString()).order("criado_em", { ascending: false }).limit(25); return data || []; }
  if (nome === "propor_acao") return await proporAcao(D, contato, inp);
  return { erro: "ferramenta desconhecida" };
}

// ------------------------------------------------------------------ propor → confirmar → executar → desfazer
async function proporAcao(D: Reg, contato: Reg, a: Reg) {
  const H = hojeSP(); let resumo = "";
  const dataOk = (s: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : H.iso;
  if (a.tipo === "baixar_parcela") {
    const p = D.parcelas.find((x: Reg) => x.id === a.parcela_id); if (!p) return { erro: "parcela_id não encontrado; consulte recebiveis primeiro" }; if (p.pago) return { erro: "essa parcela já está baixada" };
    const c = D.contratos.find((x: Reg) => x.id === p.contrato_id), m = mentoradoDe(D, c); a.data = dataOk(a.data); if (a.data > H.iso) return { erro: "a data do recebimento não pode ser no futuro" };
    a.valor = a.valor && a.valor > 0 && a.valor < +p.valor ? +(+a.valor).toFixed(2) : +p.valor;
    resumo = `Dar baixa${a.valor < +p.valor ? " parcial" : ""}: ${m?.nome} · parcela ${p.numero} · ${rs(a.valor)}${a.valor < +p.valor ? ` de ${rs(p.valor)} (o resto continua em aberto)` : ""} · recebida em ${dbr(a.data)}`;
  } else if (a.tipo === "desfazer_baixa") {
    const p = D.parcelas.find((x: Reg) => x.id === a.parcela_id); if (!p || !p.pago) return { erro: "parcela não encontrada ou não está baixada" };
    resumo = `Desfazer a baixa: ${mentoradoDe(D, D.contratos.find((x: Reg) => x.id === p.contrato_id))?.nome} · parcela ${p.numero} · ${rs(p.valor)} volta para em aberto`;
  } else if (a.tipo === "lancar_despesa") {
    if (!a.descricao || !(a.valor > 0)) return { erro: "informe descricao e valor" };
    const cat = D.categorias.find((c: Reg) => c.tipo === "despesa" && norm(c.nome) === norm(a.categoria)); a.categoria = cat?.nome || "Despesas extras"; a.data = dataOk(a.data); a.pago = a.pago !== false; a.valor = +(+a.valor).toFixed(2);
    resumo = `Lançar despesa: ${a.descricao} · ${rs(a.valor)} · ${a.categoria} · ${dbr(a.data)} · ${a.pago ? "já paga" : "a pagar"}`;
  } else if (a.tipo === "marcar_despesa_paga") {
    const l = D.lancamentos.find((x: Reg) => x.id === a.lancamento_id && x.tipo === "despesa"); if (!l) return { erro: "lancamento_id não encontrado; consulte despesas primeiro" }; a.pago = a.pago !== false;
    resumo = `Marcar como ${a.pago ? "paga" : "a pagar"}: ${l.descricao || l.categoria} · ${rs(l.valor)} · vence ${dbr(l.data)}`;
  } else if (a.tipo === "encerrar_contrato") {
    const c = D.contratos.find((x: Reg) => x.id === a.contrato_id); if (!c) return { erro: "contrato_id não encontrado" }; if (c.status !== "ativo") return { erro: `o contrato já está como ${c.status}` }; if (!["nao_renovou", "cancelou"].includes(a.situacao)) return { erro: "situacao deve ser nao_renovou ou cancelou" };
    const ab = D.parcelas.filter((p: Reg) => p.contrato_id === c.id && !p.pago).length;
    resumo = `${mentoradoDe(D, c)?.nome} ${a.situacao === "cancelou" ? "cancelou" : "não renovou"}: encerrar o contrato guardando o histórico${ab ? (a.situacao === "cancelou" ? ` · ${ab} parcela(s) em aberto deixam de ser cobradas` : ` · ${ab} parcela(s) em aberto continuam em cobrança`) : ""}`;
  } else if (a.tipo === "renovar_contrato") {
    const c = D.contratos.find((x: Reg) => x.id === a.contrato_id); if (!c) return { erro: "contrato_id não encontrado" }; if (!(a.valor_total > 0)) return { erro: "informe valor_total" };
    a.entrada = Math.max(0, +a.entrada || 0); if (a.entrada > a.valor_total) return { erro: "a entrada é maior que o valor total" }; a.meses = Math.max(1, Math.round(+a.meses || c.meses || 6)); a.parcelas = Math.max(0, Math.round(a.parcelas ?? c.parcelas_saldo ?? 5)); a.data_inicio = dataOk(a.data_inicio);
    if (a.valor_total - a.entrada > 0 && !a.parcelas) return { erro: "informe em quantas parcelas fica o saldo" };
    resumo = `Renovar ${mentoradoDe(D, c)?.nome}: contrato novo de ${rs(a.valor_total)} · entrada ${rs(a.entrada)} em ${dbr(a.data_inicio)} + ${a.parcelas}x de ${rs(a.parcelas ? (a.valor_total - a.entrada) / a.parcelas : 0)} · ${a.meses} meses · o contrato atual vira “renovado”`;
  } else if (a.tipo === "criar_reuniao" || a.tipo === "remarcar_reuniao" || a.tipo === "cancelar_reuniao") {
    if (!(await agendaLigada())) return { erro: "O Google Agenda ainda não está conectado. A conexão é feita no painel, aba Agenda." };
    let atual: Reg | null = null;
    if (a.tipo !== "criar_reuniao") { atual = await acharEvento(String(a.evento_id || "")); if (!atual) return { erro: "evento_id não encontrado; consulte a agenda primeiro" }; }
    if (a.tipo === "cancelar_reuniao") resumo = `Cancelar na agenda: ${atual!.titulo} · ${dbr(atual!.inicio)} às ${String(atual!.inicio).slice(11, 16)}${(atual!.convidados || []).length ? " · os convidados são avisados" : ""}`;
    else {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(a.inicio || ""))) return { erro: "informe inicio como AAAA-MM-DDTHH:MM (horário de São Paulo)" };
      a.inicio = String(a.inicio).slice(0, 16); if (msSP(a.inicio) < Date.now() - 5 * 60000) return { erro: "esse horário já passou" };
      const dur = a.duracao_min ? Math.max(15, Math.round(+a.duracao_min)) : atual ? Math.max(15, Math.round((Date.parse(atual.fim) - Date.parse(atual.inicio)) / 60000)) : 60;
      a.fim = localSP(msSP(a.inicio) + dur * 60000);
      const dia = a.inicio.slice(0, 10), doDia = await agenda({ acao: "listar", de: `${dia}T00:00:00`, ate: `${dia}T23:59:59` }), ini = msSP(a.inicio), fim = msSP(a.fim);
      const cruza = (doDia.eventos || []).filter((e: Reg) => !e.dia_inteiro && e.id !== a.evento_id && Date.parse(e.inicio) < fim && Date.parse(e.fim) > ini);
      const aviso = cruza.length ? ` · ATENÇÃO: cruza com ${cruza.map((e: Reg) => `${e.titulo} (${localSP(Date.parse(e.inicio)).slice(11)})`).join(", ")}` : "";
      if (a.tipo === "remarcar_reuniao") { a.inicio_antigo = localSP(Date.parse(atual!.inicio)); a.fim_antigo = localSP(Date.parse(atual!.fim)); resumo = `Remarcar: ${atual!.titulo} · de ${dbr(atual!.inicio)} ${a.inicio_antigo.slice(11)} para ${dbr(dia)} das ${a.inicio.slice(11)} às ${a.fim.slice(11)}${aviso}`; }
      else { const m = a.mentorado_id ? D.mentorados.find((x: Reg) => x.id === a.mentorado_id) : null; a.titulo = String(a.titulo || (m ? `Call · ${m.nome}` : "Reunião")).slice(0, 120); a.convidados = (a.convidados || []).filter((e: unknown) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e)));
        resumo = `Marcar na agenda: ${a.titulo} · ${dbr(dia)} das ${a.inicio.slice(11)} às ${a.fim.slice(11)}${a.meet === false ? "" : " · com link do Meet"}${a.convidados.length ? ` · convidar ${a.convidados.join(", ")}` : ""}${aviso}`; }
    }
  } else return { erro: "tipo de ação desconhecido" };
  await sb.from("assessor_pendentes").update({ estado: "expirada", resolvido_em: new Date().toISOString() }).eq("telefone", contato.telefone).eq("estado", "pendente");
  const { data, error } = await sb.from("assessor_pendentes").insert({ telefone: contato.telefone, acao: a, resumo }).select().single();
  if (error) return { erro: error.message };
  return { ok: true, proposta_id: data.id, resumo, instrucao: "Mostre esse resumo ao usuário e peça a confirmação. O sistema acrescenta os botões Confirmar e Cancelar." };
}

async function executar(pend: Reg, contato: Reg): Promise<{ texto: string; eventoId?: string }> {
  const a = pend.acao as Reg, H = hojeSP(); const titulo = pend.resumo; let tipo = "acao", desfazer: Reg | null = null, ref: Reg = {}, extra = "";
  const falha = (m: string) => { throw new Error(m); };
  if (a.tipo === "baixar_parcela") {
    const { data: p } = await sb.from("parcelas").select("*").eq("id", a.parcela_id).single(); if (!p || p.pago) falha("a parcela já não está em aberto");
    const parcial = a.valor < +p.valor - 0.005; let restoId = null;
    const { error } = await sb.from("parcelas").update({ pago: true, data_pagamento: a.data, ...(parcial ? { valor: a.valor } : {}) }).eq("id", p.id); if (error) falha(error.message);
    if (parcial) { const { data: r } = await sb.from("parcelas").insert({ contrato_id: p.contrato_id, numero: p.numero, valor: +(+p.valor - a.valor).toFixed(2), vencimento: p.vencimento, pago: false }).select().single(); restoId = r?.id || null; }
    tipo = "baixa"; ref = { ref_tabela: "parcelas", ref_id: p.id }; desfazer = { tipo: "baixa", parcela_id: p.id, valor_original: +p.valor, resto_id: restoId };
  } else if (a.tipo === "desfazer_baixa") {
    const { error } = await sb.from("parcelas").update({ pago: false, data_pagamento: null }).eq("id", a.parcela_id); if (error) falha(error.message); tipo = "baixa_desfeita";
  } else if (a.tipo === "lancar_despesa") {
    const { data: l, error } = await sb.from("lancamentos").insert({ data: a.data, competencia: a.data.slice(0, 8) + "01", tipo: "despesa", categoria: a.categoria, descricao: a.descricao, valor: a.valor, escopo: /pessoal/i.test(a.categoria) ? "pessoal" : "empresa", pago: a.pago }).select().single(); if (error) falha(error.message);
    tipo = "lancamento"; ref = { ref_tabela: "lancamentos", ref_id: l.id }; desfazer = { tipo: "lancamento", id: l.id };
  } else if (a.tipo === "marcar_despesa_paga") {
    const { data: l } = await sb.from("lancamentos").select("pago").eq("id", a.lancamento_id).single(); const { error } = await sb.from("lancamentos").update({ pago: a.pago }).eq("id", a.lancamento_id); if (error) falha(error.message);
    tipo = "pagamento"; desfazer = { tipo: "pago", id: a.lancamento_id, pago: !!l?.pago };
  } else if (a.tipo === "encerrar_contrato") {
    const st = a.situacao === "cancelou" ? "cancelado" : "concluido"; const { data: c } = await sb.from("contratos").select("*").eq("id", a.contrato_id).single();
    const { error } = await sb.from("contratos").update({ status: st, encerrado_em: H.iso }).eq("id", a.contrato_id); if (error) falha(error.message); await ajustarMentorado(c.mentorado_id);
    tipo = st === "cancelado" ? "cancelamento" : "encerramento"; ref = { ref_tabela: "contratos", ref_id: a.contrato_id }; desfazer = { tipo: "contrato", id: a.contrato_id };
  } else if (a.tipo === "renovar_contrato") {
    const { data: old } = await sb.from("contratos").select("*").eq("id", a.contrato_id).single(); if (!old) falha("contrato não encontrado");
    const [y, m, d] = a.data_inicio.split("-").map(Number), fim = new Date(Date.UTC(y, m - 1 + a.meses, d)).toISOString().slice(0, 10);
    const { data: c, error } = await sb.from("contratos").insert({ mentorado_id: old.mentorado_id, produto_id: old.produto_id, valor_total: a.valor_total, entrada: a.entrada, meses: a.meses, parcelas_saldo: a.parcelas, revisado: true, data_inicio: a.data_inicio, data_fim: fim, status: "ativo", renovacao_de: old.id }).select().single(); if (error) falha(error.message);
    const ps: Reg[] = []; let n = 0; const saldo = a.valor_total - a.entrada;
    if (a.entrada > 0) ps.push({ contrato_id: c.id, numero: ++n, valor: a.entrada, vencimento: a.data_inicio, pago: true, data_pagamento: a.data_inicio });
    if (saldo > 0 && a.parcelas > 0) { const base = Math.floor(saldo / a.parcelas * 100) / 100; for (let i = 0; i < a.parcelas; i++) ps.push({ contrato_id: c.id, numero: ++n, valor: i === a.parcelas - 1 ? +(saldo - base * (a.parcelas - 1)).toFixed(2) : base, vencimento: new Date(Date.UTC(y, m + i, d)).toISOString().slice(0, 10), pago: false }); }
    if (ps.length) await sb.from("parcelas").insert(ps);
    await sb.from("contratos").update({ status: "renovado", encerrado_em: H.iso }).eq("id", old.id); await sb.from("mentorados").update({ status: "ativo" }).eq("id", old.mentorado_id);
    tipo = "renovacao"; ref = { ref_tabela: "contratos", ref_id: c.id }; desfazer = { tipo: "renovacao", novo_id: c.id, antigo_id: old.id, status_antigo: old.status };
  } else if (a.tipo === "criar_reuniao") {
    const r = await agenda({ acao: "criar", titulo: a.titulo, inicio: a.inicio, fim: a.fim, convidados: a.convidados || [], meet: a.meet !== false, mentorado_id: a.mentorado_id || "" });
    tipo = "agenda"; desfazer = { tipo: "reuniao", id: r.evento.id }; extra = r.evento.meet ? `\n${r.evento.meet}` : "";
  } else if (a.tipo === "remarcar_reuniao") {
    await agenda({ acao: "mover", id: a.evento_id, inicio: a.inicio, fim: a.fim }); tipo = "agenda"; desfazer = { tipo: "reuniao_movida", id: a.evento_id, inicio: a.inicio_antigo, fim: a.fim_antigo };
  } else if (a.tipo === "cancelar_reuniao") { await agenda({ acao: "cancelar", id: a.evento_id }); tipo = "agenda"; }
  const { data: ev } = await sb.from("eventos").insert({ origem: "assessor", tipo, titulo, detalhe: { telefone: contato.telefone, por: contato.nome }, desfazer, ...ref }).select().single();
  await sb.from("assessor_pendentes").update({ estado: "confirmada", resolvido_em: new Date().toISOString() }).eq("id", pend.id);
  return { texto: `*Feito.* ${titulo}.${extra}${a.tipo === "baixar_parcela" ? "\nO faturamento do mês não muda: ele vem da planilha." : ""}`, eventoId: desfazer ? ev?.id : undefined };
}
async function ajustarMentorado(id: string) {
  const { data: cs } = await sb.from("contratos").select("status").eq("mentorado_id", id); if (!cs) return;
  const st = cs.some((c) => c.status === "ativo") ? "ativo" : cs.some((c) => c.status === "cancelado") && !cs.some((c) => c.status === "concluido" || c.status === "renovado") ? "cancelado" : "concluido";
  await sb.from("mentorados").update({ status: st }).eq("id", id);
}
async function desfazerEvento(contato: Reg, eventoId?: string): Promise<string> {
  let q = sb.from("eventos").select("*").eq("origem", "assessor").is("desfeito_em", null).not("desfazer", "is", null).gte("criado_em", new Date(Date.now() - 24 * 3600 * 1000).toISOString()).order("criado_em", { ascending: false }).limit(1);
  if (eventoId) q = sb.from("eventos").select("*").eq("id", eventoId).limit(1);
  const { data } = await q; const ev = data?.[0];
  if (!ev || !ev.desfazer || ev.desfeito_em) return "Não achei nada para desfazer nas últimas 24 horas.";
  if (ev.detalhe?.telefone && canon(ev.detalhe.telefone) !== canon(contato.telefone) && contato.papel !== "dono") return "Só quem fez a ação (ou o dono) pode desfazer.";
  if (Date.now() - Date.parse(ev.criado_em) > 24 * 3600 * 1000) return "Já passou das 24 horas. Dá para ajustar pelo painel.";
  const z = ev.desfazer as Reg;
  if (z.tipo === "baixa") { await sb.from("parcelas").update({ pago: false, data_pagamento: null, valor: z.valor_original }).eq("id", z.parcela_id); if (z.resto_id) await sb.from("parcelas").delete().eq("id", z.resto_id).eq("pago", false); }
  else if (z.tipo === "lancamento") await sb.from("lancamentos").delete().eq("id", z.id);
  else if (z.tipo === "pago") await sb.from("lancamentos").update({ pago: z.pago }).eq("id", z.id);
  else if (z.tipo === "contrato") { const { data: c } = await sb.from("contratos").update({ status: "ativo", encerrado_em: null }).eq("id", z.id).select().single(); if (c) await ajustarMentorado(c.mentorado_id); }
  else if (z.tipo === "reuniao") await agenda({ acao: "cancelar", id: z.id });
  else if (z.tipo === "reuniao_movida") await agenda({ acao: "mover", id: z.id, inicio: z.inicio, fim: z.fim });
  else if (z.tipo === "renovacao") { const { data: pagas } = await sb.from("parcelas").select("id,pago,vencimento").eq("contrato_id", z.novo_id); if ((pagas || []).filter((p) => p.pago).length > 1) return "A renovação já tem parcelas baixadas depois da entrada. Desfaça pelo painel para não perder nada.";
    await sb.from("parcelas").delete().eq("contrato_id", z.novo_id); await sb.from("contratos").delete().eq("id", z.novo_id); await sb.from("contratos").update({ status: z.status_antigo || "ativo", encerrado_em: null }).eq("id", z.antigo_id); }
  await sb.from("eventos").update({ desfeito_em: new Date().toISOString() }).eq("id", ev.id);
  await sb.from("eventos").insert({ origem: "assessor", tipo: "desfeito", titulo: "Desfeito: " + ev.titulo, detalhe: { telefone: contato.telefone, por: contato.nome } });
  return `*Desfeito.* ${ev.titulo}\nVoltou a ficar como estava.`;
}

// ------------------------------------------------------------------ cérebro
function sistema(contato: Reg, temAgenda: boolean) {
  const H = hojeSP(), prefs = contato.prefs || {};
  return `Você é o Assessor Rhino, o assessor financeiro e de agenda do Consulting Framework / RHINO (mentoria para profissionais de fitness; produtos: Consulting Framework, Mentoria RHINO, Consultoria RHINO). Você conversa pelo WhatsApp com ${contato.nome}${contato.papel === "dono" ? ", dono do negócio" : ", da equipe"}.
Hoje é ${["domingo","segunda","terça","quarta","quinta","sexta","sábado"][H.sem]}, ${dbr(H.iso)}, ${H.hora} em São Paulo.

Como você responde:
- Português do Brasil, direto, frases curtas, tom de colega competente. ${prefs.como_chamar ? `Chame a pessoa de ${prefs.como_chamar}. ` : ""}${prefs.sem_emoji ? "Não use emoji. " : "No máximo um emoji por mensagem, e só quando ajudar. "}
- Formato de WhatsApp: negrito é *assim*. Nada de markdown com #, tabelas ou links inventados. Listas curtas com "•". Mensagens com menos de 900 caracteres.
- Todo número vem das ferramentas. Nunca estime nem invente valor, nome ou data. Se a ferramenta não trouxe, diga que não tem esse dado.
- Dinheiro no formato R$ 1.234,56. Datas como 10/09.
- Se o pedido estiver ambíguo (dois mentorados parecidos, parcela não identificada), pergunte antes de propor.

Regras do negócio que você precisa respeitar:
- O faturamento de cada mês vem da planilha da Ana. Dar baixa em parcela só tira da cobrança; não soma de novo. Diga isso quando alguém tiver medo de duplicar.
- Para QUALQUER alteração use a ferramenta propor_acao e peça a confirmação. Você nunca grava nada sozinho e nunca diz "feito" antes de o sistema confirmar.
- Você não movimenta dinheiro, não é contador nem consultor de investimentos. Em dúvida fiscal, diga para validar com o contador.
- Você não manda mensagem para alunos. A cobrança com um toque fica no painel (Recebíveis → Quem me deve); não ofereça "preparar cobrança".
${temAgenda ? `- Agenda: use a ferramenta agenda para ver compromissos ("o que eu tenho hoje?") e horários livres. Para marcar, remarcar ou cancelar use propor_acao (criar_reuniao, remarcar_reuniao, cancelar_reuniao). Horários sempre de São Paulo; resolva "quinta", "amanhã" a partir da data de hoje. Se a reunião for com um mentorado, ache o mentorado_id com a ferramenta contratos e passe junto: é assim que a call entra na contagem dele. Se o resumo da proposta avisar que cruza com outro compromisso, diga isso e ofereça outro horário livre.` : `- O Google Agenda ainda não está conectado. Se pedirem agenda ou reunião, diga que a conexão é feita no painel, aba Agenda, e leva 5 minutos.`}`;
}
async function chamarClaude(system: string, messages: Reg[], tools: Reg[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: MODELO, max_tokens: 1200, system, messages, tools }) });
  if (!r.ok) throw new Error(`Claude respondeu ${r.status}: ${(await r.text()).slice(0, 240)}`);
  return await r.json();
}
async function pensar(contato: Reg, conteudo: unknown): Promise<string> {
  if (!env("ANTHROPIC_API_KEY")) return "Falta a chave da IA (ANTHROPIC_API_KEY) nos segredos do Supabase.";
  const D = await carregar(), temAgenda = await agendaLigada();
  const { data: hist } = await sb.from("assessor_mensagens").select("direcao,texto").eq("telefone", contato.telefone).not("texto", "is", null).order("criado_em", { ascending: false }).limit(10);
  const msgs: Reg[] = [];
  for (const h of (hist || []).reverse()) { const role = h.direcao === "in" ? "user" : "assistant"; if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += "\n" + h.texto; else msgs.push({ role, content: h.texto }); }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (msgs.length && msgs[msgs.length - 1].role === "user") msgs.pop(); // a mensagem atual já foi gravada no histórico
  msgs.push({ role: "user", content: conteudo });
  for (let volta = 0; volta < 6; volta++) {
    const resp = await chamarClaude(sistema(contato, temAgenda), msgs, TOOLS);
    const usos = (resp.content || []).filter((b: Reg) => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || !usos.length) return (resp.content || []).filter((b: Reg) => b.type === "text").map((b: Reg) => b.text).join("\n").trim() || "Não consegui montar a resposta. Tenta de novo?";
    msgs.push({ role: "assistant", content: resp.content });
    const resultados = [];
    for (const u of usos) { let out: unknown; try { out = await usarFerramenta(D, contato, u.name, u.input || {}); } catch (e) { out = { erro: String((e as Error).message || e) }; } resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out).slice(0, 14000) }); }
    msgs.push({ role: "user", content: resultados });
  }
  return "Fiquei dando voltas nessa. Pode me pedir de um jeito mais direto?";
}

const SIM = /^(sim|s|ss|pode|pode sim|pode ser|confirma|confirmar|confirmo|confirmado|ok|okay|isso|isso mesmo|manda|manda ver|fechado|certo|👍|✅)[\s.!]*$/i;
const NAO = /^(n[aã]o|n|nn|cancela|cancelar|cancelado|deixa|deixa pra l[aá]|esquece|para)[\s.!]*$/i;
type Resposta = { texto: string; botoes?: { id: string; titulo: string }[] };
async function responder(contato: Reg, texto: string, botao: string | null, conteudo?: unknown): Promise<Resposta> {
  const t = texto.trim();
  if (botao?.startsWith("undo:") || /^desfa(z|zer|ça)(\s|$)/i.test(t)) return { texto: await desfazerEvento(contato, botao?.startsWith("undo:") ? botao.slice(5) : undefined) };
  if (/^(ver )?resumo$/i.test(t) || botao === "ver_resumo") { const pend = contato.prefs?.relatorio_pendente; if (pend) { await sb.from("assessor_contatos").update({ prefs: { ...contato.prefs, relatorio_pendente: null } }).eq("telefone", contato.telefone); return { texto: pend }; } }
  const { data: ps } = await sb.from("assessor_pendentes").select("*").eq("telefone", contato.telefone).eq("estado", "pendente").gte("criado_em", new Date(Date.now() - 30 * 60000).toISOString()).order("criado_em", { ascending: false }).limit(1);
  const pend = ps?.[0];
  if (pend) {
    if (botao === "ok:" + pend.id || (!botao && SIM.test(t))) { try { const r = await executar(pend, contato); return { texto: r.texto, botoes: r.eventoId ? [{ id: "undo:" + r.eventoId, titulo: "Desfazer" }] : undefined }; } catch (e) { await sb.from("assessor_pendentes").update({ estado: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", pend.id); return { texto: "Não consegui gravar: " + String((e as Error).message || e) + "\nNada foi alterado." }; } }
    await sb.from("assessor_pendentes").update({ estado: "cancelada", resolvido_em: new Date().toISOString() }).eq("id", pend.id);
    if (botao === "no:" + pend.id || (!botao && NAO.test(t))) return { texto: "Cancelado. Nada foi alterado." };
  } else if (botao?.startsWith("ok:") || botao?.startsWith("no:")) return { texto: "Essa proposta já expirou. Me pede de novo que eu monto outra." };
  const resposta = await pensar(contato, conteudo ?? t);
  const { data: nova } = await sb.from("assessor_pendentes").select("id").eq("telefone", contato.telefone).eq("estado", "pendente").gte("criado_em", new Date(Date.now() - 60000).toISOString()).limit(1);
  return nova?.[0] ? { texto: resposta, botoes: [{ id: "ok:" + nova[0].id, titulo: "Confirmar" }, { id: "no:" + nova[0].id, titulo: "Cancelar" }] } : { texto: resposta };
}

// ------------------------------------------------------------------ WhatsApp
async function wa(corpo: Reg) {
  const r = await fetch(`${GRAPH}/${cfg("WHATSAPP_PHONE_ID")}/messages`, { method: "POST", headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", ...corpo }) });
  if (!r.ok) console.error("WhatsApp recusou:", r.status, (await r.text()).slice(0, 300));
  return r.ok;
}
async function enviar(para: string, resp: Resposta) {
  const partes = resp.texto.match(/[\s\S]{1,3800}(?=\n|$)|[\s\S]{1,3800}/g) || [resp.texto];
  for (let i = 0; i < partes.length; i++) {
    const ultimo = i === partes.length - 1, body = partes[i].trim(); if (!body) continue;
    if (ultimo && resp.botoes?.length) await wa({ to: para, type: "interactive", interactive: { type: "button", body: { text: body.slice(0, 1024) }, action: { buttons: resp.botoes.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.titulo.slice(0, 20) } })) } } });
    else await wa({ to: para, type: "text", text: { body, preview_url: false } });
  }
  await sb.from("assessor_mensagens").insert({ telefone: para, direcao: "out", tipo: resp.botoes?.length ? "interactive" : "text", texto: resp.texto });
}
async function baixarMidia(id: string) {
  const m = await (await fetch(`${GRAPH}/${id}`, { headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}` } })).json();
  const r = await fetch(m.url, { headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}` } });
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime: String(m.mime_type || "application/octet-stream").split(";")[0] };
}
async function transcrever(id: string): Promise<string | null> {
  const groq = env("GROQ_API_KEY"), openai = env("OPENAI_API_KEY"); if (!groq && !openai) return null;
  const { bytes, mime } = await baixarMidia(id); const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime }), "audio.ogg"); fd.append("model", groq ? "whisper-large-v3" : "whisper-1"); fd.append("language", "pt");
  const r = await fetch(groq ? "https://api.groq.com/openai/v1/audio/transcriptions" : "https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${groq || openai}` }, body: fd });
  if (!r.ok) { console.error("transcrição falhou", r.status, (await r.text()).slice(0, 200)); return ""; }
  return String((await r.json()).text || "").trim();
}
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

async function acharContato(de: string): Promise<Reg | null> {
  const { data } = await sb.from("assessor_contatos").select("*").eq("ativo", true);
  return (data || []).find((c) => canon(c.telefone) === canon(de)) || null;
}
async function processarMensagem(m: Reg) {
  const de = String(m.from || ""); const contato = await acharContato(de);
  if (!contato) { console.log("número não autorizado, ignorado:", de.slice(0, 6) + "…"); return; }
  const botao: string | null = m.interactive?.button_reply?.id || (m.type === "button" ? (/resumo/i.test(m.button?.text || "") ? "ver_resumo" : null) : null);
  let texto = m.text?.body || m.interactive?.button_reply?.title || m.button?.text || m.image?.caption || "";
  const { error: dup } = await sb.from("assessor_mensagens").insert({ telefone: contato.telefone, direcao: "in", tipo: m.type, texto: texto || null, wa_id: m.id });
  if (dup) return; // a Meta reenviou a mesma mensagem
  await sb.from("assessor_contatos").update({ ultimo_contato: new Date().toISOString(), wa_id: de }).eq("telefone", contato.telefone); // "de" é o identificador exato que a Meta usa (às vezes sem o nono dígito)
  await wa({ status: "read", message_id: m.id });
  let conteudo: unknown;
  try {
    if (m.type === "audio") {
      const t = await transcrever(m.audio.id);
      if (t === null) return await enviar(de, { texto: "Ainda não estou ouvindo áudios: falta ligar a transcrição. Me manda por texto?" });
      if (!t) return await enviar(de, { texto: "Não consegui entender o áudio. Pode repetir ou mandar por texto?" });
      texto = t; await sb.from("assessor_mensagens").update({ texto: `(áudio) ${t}` }).eq("wa_id", m.id);
    } else if (m.type === "image") {
      const { bytes, mime } = await baixarMidia(m.image.id);
      conteudo = [{ type: "image", source: { type: "base64", media_type: mime, data: b64(bytes) } }, { type: "text", text: (texto ? texto + "\n\n" : "") + "Isto é um comprovante de pagamento ou um boleto. Se for comprovante de um mentorado, ache a parcela em aberto correspondente (nome e valor) e proponha a baixa na data do comprovante. Se for boleto ou conta, proponha lançar a despesa a pagar com o vencimento. Se não der para ler com segurança, diga o que faltou." }];
      await sb.from("assessor_mensagens").update({ texto: `(imagem) ${texto}`.trim() }).eq("wa_id", m.id);
    } else if (!texto) return await enviar(de, { texto: "Por enquanto eu entendo texto, áudio e foto de comprovante ou boleto." });
    await enviar(de, await responder(contato, texto, botao, conteudo));
  } catch (e) {
    console.error("erro ao responder:", e);
    await enviar(de, { texto: "Tive um problema para responder agora. Tenta de novo em um minuto?" });
  }
}
async function assinaturaOk(req: Request, corpo: string) {
  const seg = env("WHATSAPP_APP_SECRET").trim(), ass = req.headers.get("x-hub-signature-256") || ""; if (!seg || !ass.startsWith("sha256=")) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(seg), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(corpo)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join(""), dada = ass.slice(7);
  let dif = hex.length === dada.length ? 0 : 1; for (let i = 0; i < Math.min(hex.length, dada.length); i++) dif |= hex.charCodeAt(i) ^ dada.charCodeAt(i);
  // pista para diagnóstico, sem revelar o segredo: a chave secreta de um app da Meta tem 32 caracteres de 0-9 e a-f
  if (dif !== 0) console.error("assinatura da Meta não confere", { tamanho_da_chave: seg.length, formato_esperado: /^[0-9a-f]{32}$/.test(seg) });
  return dif === 0;
}

// ------------------------------------------------------------------ relatórios automáticos
function pendenciasTexto(D: Reg) {
  const L: string[] = [], ab = abertas(D), atr = ab.filter((p: Reg) => p.d < 0), H = hojeSP();
  const venc = D.contratos.filter((c: Reg) => c.status === "ativo" && diasAte(c.data_fim) < 0).length, prox = D.contratos.filter((c: Reg) => c.status === "ativo" && diasAte(c.data_fim) >= 0 && diasAte(c.data_fim) <= 7);
  if (atr.length) L.push(`• ${atr.length} parcela${atr.length > 1 ? "s" : ""} vencida${atr.length > 1 ? "s" : ""}: ${rsc(atr.reduce((s: number, p: Reg) => s + +p.valor, 0))}`);
  if (venc) L.push(`• ${venc} contrato${venc > 1 ? "s" : ""} vencido${venc > 1 ? "s" : ""} esperando decisão (renovou ou não?)`);
  for (const c of prox) L.push(`• Contrato de ${mentoradoDe(D, c)?.nome} vence em ${diasAte(c.data_fim)} dia(s)`);
  const atras = D.lancamentos.filter((l: Reg) => l.tipo === "despesa" && !l.pago && String(l.data) < H.iso && noMes(l.data, H.ano, H.mes));
  if (atras.length) L.push(`• ${atras.length} conta${atras.length > 1 ? "s" : ""} atrasada${atras.length > 1 ? "s" : ""}: ${rsc(atras.reduce((s: number, l: Reg) => s + +l.valor, 0))}`);
  return L;
}
async function montarRelatorio(tipo: string, D: Reg, contato: Reg): Promise<string> {
  const H = hojeSP(), nome = (contato.prefs?.como_chamar || contato.nome).split(" ")[0], R = resumoMes(D, H.ano, H.mes);
  if (tipo === "bom_dia") {
    const em3 = somaIso(H.iso, 3), contas = D.lancamentos.filter((l: Reg) => l.tipo === "despesa" && !l.pago && String(l.data) >= H.iso && String(l.data) <= em3).sort((a: Reg, b: Reg) => String(a.data).localeCompare(String(b.data)));
    const entram = abertas(D).filter((p: Reg) => p.d >= 0 && p.d <= 3), s = R.semana_atual!, pend = pendenciasTexto(D);
    let agendaHoje = "";
    try { if (await agendaLigada()) { const r = await agenda({ acao: "listar", de: `${H.iso}T00:00:00`, ate: `${H.iso}T23:59:59` }); const L = (r.eventos || []).filter((e: Reg) => !e.dia_inteiro);
      agendaHoje = L.length ? `*Agenda de hoje*\n${L.slice(0, 8).map((e: Reg) => `• ${localSP(Date.parse(e.inicio)).slice(11)} ${e.titulo}`).join("\n")}` : "*Agenda de hoje:* nenhum compromisso marcado."; } } catch (_) { agendaHoje = ""; }
    const { data: evs } = await sb.from("eventos").select("titulo").eq("origem", "planilha").gte("criado_em", new Date(Date.now() - 24 * 3600 * 1000).toISOString()).order("criado_em", { ascending: false }).limit(3);
    return [`*Bom dia, ${nome}.* ${["Domingo","Segunda","Terça","Quarta","Quinta","Sexta","Sábado"][H.sem]}, ${dbr(H.iso)}.`, agendaHoje,
      `*${MESES[H.mes][0].toUpperCase() + MESES[H.mes].slice(1)} até aqui*\nEntrou ${rsc(R.recebido)} · saiu ${rsc(R.despesas_total)}\nResultado ${rsc(R.resultado)}${R.margem_pct != null ? ` (${R.margem_pct.toFixed(0)}%)` : ""}${R.meta ? ` · ${R.pct_da_meta}% da meta` : ""}`,
      `*Semana ${s.n}* (${s.de} a ${s.ate}): ${rsc(s.valor)} de ${rsc(s.alvo)} · ${s.pct.toFixed(0)}%`,
      contas.length ? `*Vence até ${dbr(em3)}*\n${contas.slice(0, 6).map((l: Reg) => `• ${dbr(l.data)} ${l.descricao || l.categoria} · ${rsc(l.valor)}`).join("\n")}${contas.length > 6 ? `\n• e mais ${contas.length - 6}` : ""}` : "*Contas:* nada vence nos próximos 3 dias.",
      entram.length ? `*Entra até ${dbr(em3)}*\n${entram.slice(0, 6).map((p: Reg) => `• ${dbr(p.vencimento)} ${p.mentorado.nome.split(" ").slice(0, 2).join(" ")} · ${rsc(p.valor)}`).join("\n")}` : "",
      pend.length ? `*Pede a sua ação*\n${pend.join("\n")}` : "Nada pendente. Tudo em dia.",
      evs?.length ? `*Desde ontem*\n${evs.map((e) => "• " + e.titulo.replace(/^Planilha: /, "")).join("\n")}` : ""].filter(Boolean).join("\n\n");
  }
  if (tipo === "semana") {
    const s = R.semana_atual!, ini = `${H.ano}-${pad(H.mes + 1)}-${pad(s.de)}`, baixas = D.parcelas.filter((p: Reg) => p.pago && String(p.data_pagamento || "") >= ini && String(p.data_pagamento || "") <= H.iso);
    const cobrar = abertas(D).filter((p: Reg) => p.d <= -7), prox = somaIso(H.iso, 7), saem = D.lancamentos.filter((l: Reg) => l.tipo === "despesa" && !l.pago && String(l.data) > H.iso && String(l.data) <= prox).sort((a: Reg, b: Reg) => +b.valor - +a.valor);
    const venc30 = D.contratos.filter((c: Reg) => c.status === "ativo" && diasAte(c.data_fim) >= 0 && diasAte(c.data_fim) <= 30).length;
    return [`*Fechamento da semana ${s.n} de ${MESES[H.mes]}*`, `Meta ${rsc(s.alvo)} · entrou ${rsc(s.valor)} (${s.pct.toFixed(0)}%)\n${baixas.length} parcela${baixas.length === 1 ? "" : "s"} baixada${baixas.length === 1 ? "" : "s"} na semana`,
      `*No mês:* ${rsc(R.recebido)} recebidos${R.meta ? `, ${R.pct_da_meta}% da meta` : ""} · resultado ${rsc(R.resultado)}`,
      cobrar.length ? `*Quem cobrar* (vencidas há mais de 7 dias)\n${cobrar.slice(0, 8).map((p: Reg) => `• ${p.mentorado.nome.split(" ").slice(0, 2).join(" ")} · ${rsc(p.valor)} · ${-p.d} dias`).join("\n")}${cobrar.length > 8 ? `\n• e mais ${cobrar.length - 8}` : ""}` : "*Cobrança:* ninguém com mais de 7 dias de atraso.",
      saem.length ? `*Semana que vem saem ${rsc(saem.reduce((t: number, l: Reg) => t + +l.valor, 0))}*\n${saem.slice(0, 5).map((l: Reg) => `• ${dbr(l.data)} ${l.descricao || l.categoria} · ${rsc(l.valor)}`).join("\n")}` : "",
      venc30 ? `${venc30} contrato${venc30 > 1 ? "s vencem" : " vence"} nos próximos 30 dias.` : ""].filter(Boolean).join("\n\n");
  }
  // mês: fechamento do mês anterior (o agendador de fechamentos já gravou a tabela)
  const ant = new Date(Date.UTC(H.ano, H.mes - 1, 1)), F = resumoMes(D, ant.getUTCFullYear(), ant.getUTCMonth()), g = Object.entries(F.despesas_por_grupo as Reg).sort((a, b) => +b[1] - +a[1]).slice(0, 4);
  return [`*Fechamento de ${F.mes}*`, `Recebido ${rs(F.recebido)}${F.meta ? ` · ${F.pct_da_meta}% da meta de ${rsc(F.meta)}` : ""}\nDespesas ${rs(F.despesas_total)}\n*Resultado ${rs(F.resultado)}*${F.margem_pct != null ? ` · margem ${F.margem_pct.toFixed(0)}%` : ""}`,
    `Contra ${F.mes_anterior.mes}: recebido ${rsc(F.mes_anterior.recebido)}, resultado ${rsc(F.mes_anterior.resultado)}`, g.length ? `*Maiores grupos de despesa*\n${g.map(([k, v]) => `• ${k}: ${rsc(v)}`).join("\n")}` : "", "O fechamento ficou gravado no painel."].filter(Boolean).join("\n\n");
}
async function rotina(tipo: string, textoAviso?: string) {
  if (!env("WHATSAPP_TOKEN") || !cfg("WHATSAPP_PHONE_ID")) return { ok: false, motivo: "WhatsApp ainda não configurado" };
  const { data: contatos } = await sb.from("assessor_contatos").select("*").eq("ativo", true).eq("recebe_relatorios", true); if (!contatos?.length) return { ok: false, motivo: "nenhum número autorizado" };
  const D = tipo === "aviso" ? null : await carregar(); const enviados: string[] = [];
  for (const c of contatos) {
    const texto = tipo === "aviso" ? String(textoAviso || "") : await montarRelatorio(tipo, D!, c); if (!texto) continue;
    const naJanela = c.ultimo_contato && Date.now() - Date.parse(c.ultimo_contato) < 23.5 * 3600 * 1000;
    const destino = c.wa_id || c.telefone;
    if (naJanela) { await enviar(destino, { texto }); enviados.push("texto"); continue; }
    if (tipo === "aviso") continue; // aviso avulso fora da janela fica para o resumo da manhã
    await sb.from("assessor_contatos").update({ prefs: { ...(c.prefs || {}), relatorio_pendente: texto } }).eq("telefone", c.telefone);
    const ok = await wa({ to: destino, type: "template", template: { name: env("WHATSAPP_TEMPLATE_RESUMO") || "resumo_pronto", language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: (c.prefs?.como_chamar || c.nome).split(" ")[0] }] }] } });
    enviados.push(ok ? "modelo" : "modelo recusado");
  }
  return { ok: true, tipo, enviados };
}

// ------------------------------------------------------------------ entrada
Deno.serve(async (req) => {
  const url = new URL(req.url); await carregarCfg();
  if (req.method === "GET") { // verificação do webhook pela Meta
    const ok = url.searchParams.get("hub.mode") === "subscribe" && !!cfg("WHATSAPP_VERIFY_TOKEN") && url.searchParams.get("hub.verify_token") === cfg("WHATSAPP_VERIFY_TOKEN");
    return ok ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200 }) : new Response("token de verificação não confere", { status: 403 });
  }
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  const corpo = await req.text();

  const cron = req.headers.get("x-rhino-cron");
  if (cron) { // chamadas internas: agendador do banco e testes
    const { data: seg } = await sb.from("assessor_segredos").select("valor").eq("chave", "cron").maybeSingle();
    if (!seg?.valor || cron !== seg.valor) return json({ erro: "não autorizado" }, 401);
    const b = JSON.parse(corpo || "{}");
    try {
      if (b.status) return json({ ia: !!env("ANTHROPIC_API_KEY"), whatsapp_token: !!env("WHATSAPP_TOKEN"), whatsapp_phone_id: !!cfg("WHATSAPP_PHONE_ID"), whatsapp_app_secret: !!env("WHATSAPP_APP_SECRET"), whatsapp_verify_token: !!cfg("WHATSAPP_VERIFY_TOKEN"), audio: !!(env("GROQ_API_KEY") || env("OPENAI_API_KEY")), modelo: MODELO });
      if (b.meta) { // diagnóstico e assinatura da conta do WhatsApp neste app: usa o token do cofre e nunca o devolve
        const H = { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}` }, waba = String(b.waba_id || "").replace(/\D/g, "");
        const g = async (u: string, init?: RequestInit) => { const r = await fetch(`${GRAPH}/${u}`, { ...init, headers: H }); return { status: r.status, corpo: await r.json().catch(() => null) }; };
        if (b.meta === "assinar") return json(await g(`${waba}/subscribed_apps`, { method: "POST" }));
        return json({ numero: await g(`${cfg("WHATSAPP_PHONE_ID")}?fields=display_phone_number,verified_name,quality_rating,platform_type,code_verification_status`), apps_assinados: await g(`${waba}/subscribed_apps`) });
      }
      if (b.rotina) return json(await rotina(String(b.rotina), b.texto));
      if (b.previa) return json({ texto: await montarRelatorio(String(b.previa), await carregar(), { nome: b.nome || "Henrique", prefs: {} }) });
      if (b.teste) { // conversa de teste, sem WhatsApp: devolve a resposta em JSON
        const contato = { telefone: String(b.telefone || "teste"), nome: b.nome || "Henrique", papel: "dono", prefs: {} };
        await sb.from("assessor_mensagens").insert({ telefone: contato.telefone, direcao: "in", tipo: "text", texto: b.teste });
        const r = await responder(contato, String(b.teste), b.botao || null);
        await sb.from("assessor_mensagens").insert({ telefone: contato.telefone, direcao: "out", tipo: "text", texto: r.texto });
        return json(r);
      }
      return json({ erro: "pedido interno desconhecido" }, 400);
    } catch (e) { return json({ erro: String((e as Error).message || e) }, 500); }
  }

  if (!(await assinaturaOk(req, corpo))) return new Response("assinatura inválida", { status: 401 });
  const payload = JSON.parse(corpo || "{}");
  const mensagens: Reg[] = (payload.entry || []).flatMap((e: Reg) => (e.changes || []).flatMap((c: Reg) => c.value?.messages || []));
  const trabalho = (async () => { for (const m of mensagens) await processarMensagem(m); })();
  // responde 200 já (a Meta reenvia se demorar) e continua trabalhando em segundo plano
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime; if (er?.waitUntil) er.waitUntil(trabalho); else await trabalho;
  return new Response("ok", { status: 200 });
});
