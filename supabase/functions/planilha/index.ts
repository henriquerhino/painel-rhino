// ============================================================
// PAINEL RHINO · Edge Function "planilha"
// Sincroniza a planilha do Google com o banco, no servidor, de hora em hora
// (agendada pelo pg_cron). É a mesma regra do bloco PLANILHA do index.html:
// se mudar lá, mude aqui.
//
// Quem pode chamar: só quem manda o cabeçalho x-rhino-cron com o segredo que
// fica na tabela assessor_segredos (o agendador do banco lê de lá).
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const PLANILHA = {
  id: "1WsgpupBx_CXdEf_zI1vUXjAemtuUQdGNJ2eje2Er4Sc",
  gid: 1973263952, // aba "Planilha financeira - RESULTADO"
  ano: 2026,
  receitas: ["consultoria", "mentoria", "framework"],
};
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const rs = (v: number) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Hoje em São Paulo (UTC−3, sem horário de verão). */
function hojeSP() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  const ano = d.getUTCFullYear(), mes = d.getUTCMonth(), dia = d.getUTCDate();
  return { ano, mes, dia, iso: `${ano}-${String(mes + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}` };
}

function csvParse(t: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) { const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function brl(s: unknown): number | null {
  if (s == null) return null; let t = String(s).trim(); if (!t) return null;
  const temRS = /R\$/.test(t), neg = /^\s*-|^\(/.test(t);
  const num = t.replace(/[^\d,.]/g, "");
  if (!/\d/.test(num)) return temRS ? 0 : null;
  if (!temRS && /[a-zA-Z]/.test(t)) return null;
  const v = parseFloat(num.replace(/\./g, "").replace(",", "."));
  return isNaN(v) ? null : (neg ? -v : v);
}
const slug = (s: string) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const limparItem = (l: string) => l.replace(/\s*-\s*\d{1,2}(\s*e\s*\d{1,2})?\s*$/, "").replace(/\s+/g, " ").replace(/\)\)/g, ")").trim();
const diaDoItem = (l: string) => { const m = l.match(/-\s*(\d{1,2})(?:\s*e\s*\d{1,2})?\s*$/); const d = m ? +m[1] : 0; return d >= 1 && d <= 31 ? d : null; };

type Linha = { label: string; vals: (number | null)[]; grupo?: string };
function lerFinanceira(rows: string[][]) {
  const out: { receitas: Linha[]; despesas: Linha[]; metas: (number | null)[] | null } = { receitas: [], despesas: [], metas: null };
  let sec = "", grupo: string | null = null;
  for (const r of rows) {
    const label = String(r[0] || "").replace(/\s+/g, " ").trim();
    const vals = r.slice(1, 13).map(brl);
    const temValor = vals.some((v) => v != null), L = label.toUpperCase();
    if (!label && !temValor) continue;
    if (/^PLANILHA FINANCEIRA|^RECEITAS$/.test(L)) { sec = "rec"; continue; }
    if (L === "DESPESAS") { sec = "desp"; grupo = null; continue; }
    if (/^META/.test(L)) { sec = "meta"; continue; }
    if (/^BALAN/.test(L) || (/^CARTEIRAS? DE INVESTIMENTO/.test(L) && !temValor)) { sec = "fim"; continue; }
    if (sec === "rec") { if (/^RECEBIMENTO/.test(L)) out.receitas.push({ label, vals }); continue; }
    if (sec === "desp") {
      if (/^TOTAL DAS DESPESAS/.test(L)) { sec = "fim"; continue; }
      if (/^TOTAL$/.test(L)) { grupo = null; continue; }
      if (label && !temValor) { grupo = label; continue; }
      if (temValor) out.despesas.push({ grupo: grupo || "Extras", label: label || `${grupo || "Despesa"} (sem descrição)`, vals });
      continue;
    }
    if (sec === "meta") { if (/^OBJETIVO/.test(L)) out.metas = vals; continue; }
  }
  return out;
}
function classificar(grupo: string, label: string) {
  const s = (grupo + " » " + label).toLowerCase(), g = grupo.toLowerCase(), l = label.toLowerCase();
  const emp = /\bpj\b|\(empresa\)/.test(s);
  if (/cart/.test(g)) return emp ? { cat: "Cartões · empresa", mat: "Cartões", esc: "empresa" } : { cat: "Cartões · pessoal", mat: "Cartões", esc: "pessoal" };
  if (/imposto|inss|taxa/.test(l)) return { cat: "Impostos", mat: "Impostos", esc: "empresa" };
  if (/repasse jefferson|repasse soc|provis|ipva|manuten/.test(s)) return { cat: "Provisões financeiras", mat: "Provisões financeiras", esc: /repasse/.test(s) ? "empresa" : "pessoal" };
  if (/carteira de invest|aporte/.test(s)) return { cat: "Investimentos", mat: "Investimentos", esc: "ambos" };
  if (/despesas extras|extra/.test(l)) return { cat: "Despesas extras", mat: "Despesas extras", esc: "pessoal" };
  if (/casa|fixo/.test(g)) return /aluguel rec/.test(s) ? { cat: "Despesas fixas · Empresa", mat: "Despesas fixas · Empresa", esc: "empresa" } : { cat: "Despesas fixas · Pessoal", mat: "Despesas fixas · Pessoal", esc: "pessoal" };
  if (/colaborador/.test(g)) {
    if (/terapia|diarista|seguro|celular|sa[uú]de|treino|suplemento/.test(s)) return { cat: "Despesas fixas · Pessoal", mat: "Despesas fixas · Pessoal", esc: "pessoal" };
    if (/flowize|vivo|caixa postal|ferramenta|moda|hubla|cal\.com|typeform|plataforma|aplicativo/.test(s)) return { cat: "Despesas fixas · Empresa", mat: "Despesas fixas · Empresa", esc: "empresa" };
    return { cat: "Colaboradores", mat: "Colaboradores", esc: "empresa" };
  }
  return { cat: "Despesas extras", mat: "Despesas extras", esc: "pessoal" };
}
function receitaDe(label: string) {
  const L = label.toLowerCase();
  if (/framework/.test(L)) return { chave: "framework", cat: "Receita de contrato", re: [/framework/i] };
  if (/mentoria/.test(L)) return { chave: "mentoria", cat: "Receita de contrato", re: [/mentoria/i, /rhino/i] };
  return { chave: "consultoria", cat: "Receita avulsa", re: [/consultoria/i] };
}

// deno-lint-ignore no-explicit-any
type Reg = Record<string, any>;
async function garantirCategorias(cats: Reg[], itens: { nome: string; matriz: string; tipo: string; escopo: string }[]) {
  const acha = (nome: string, tipo?: string) => cats.find((c) => (!tipo || c.tipo === tipo) && String(c.nome).trim().toLowerCase() === nome.trim().toLowerCase());
  const matrizes = new Map<string, Reg>();
  for (const it of itens) if (!acha(it.nome, it.tipo) && !acha(it.matriz, it.tipo)) matrizes.set(it.tipo + "|" + it.matriz, { nome: it.matriz, tipo: it.tipo, escopo: "ambos", matriz: true, parent_id: null, ordem: 90 });
  if (matrizes.size) { const { data, error } = await sb.from("categorias").insert([...matrizes.values()]).select(); if (error) throw new Error("categorias: " + error.message); cats.push(...(data || [])); }
  const filhas = new Map<string, Reg>();
  for (const it of itens) {
    if (acha(it.nome, it.tipo) || acha(it.nome)) continue;
    const m = acha(it.matriz, it.tipo); if (!m || it.nome.toLowerCase() === it.matriz.toLowerCase()) continue;
    filhas.set(it.nome.toLowerCase(), { nome: it.nome, tipo: it.tipo, escopo: it.escopo, matriz: false, parent_id: m.id, ordem: 95 });
  }
  if (filhas.size) { const { error } = await sb.from("categorias").insert([...filhas.values()]); if (error) throw new Error("categorias: " + error.message); }
}

async function sincronizar(): Promise<string> {
  const H = hojeSP(), ano = PLANILHA.ano;
  const mesMax = ano < H.ano ? 11 : ano > H.ano ? -1 : H.mes;
  if (mesMax < 0) return "o ano da planilha ainda não começou";

  const r = await fetch(`https://docs.google.com/spreadsheets/d/${PLANILHA.id}/gviz/tq?tqx=out:csv&gid=${PLANILHA.gid}&t=${Date.now()}`);
  if (!r.ok) throw new Error(`a planilha não respondeu (${r.status})`);
  const txt = await r.text();
  if (/<html/i.test(txt.slice(0, 300))) throw new Error("a planilha não está pública (qualquer pessoa com o link · leitor)");
  const dados = lerFinanceira(csvParse(txt));
  if (!dados.receitas.length && !dados.despesas.length) throw new Error("não reconheci a aba financeira");

  const [{ data: produtos }, { data: cats }, { data: metasAtuais }] = await Promise.all([
    sb.from("produtos").select("id,nome"), sb.from("categorias").select("*"), sb.from("metas_mes").select("ano_mes,total"),
  ]);
  const todas: Reg[] = [], usadas: { nome: string; matriz: string; tipo: string; escopo: string }[] = [];
  for (const { label, vals } of dados.receitas) {
    const rc = receitaDe(label); if (!PLANILHA.receitas.includes(rc.chave)) continue;
    const pid = rc.re.map((re) => (produtos || []).find((p) => re.test(p.nome))).find(Boolean)?.id || null;
    usadas.push({ nome: rc.cat, matriz: "Receitas", tipo: "entrada", escopo: "empresa" });
    vals.forEach((v, m) => { if (m > mesMax || !v || v <= 0) return; const mm = String(m + 1).padStart(2, "0");
      todas.push({ origem: "planilha", origem_id: `pl:${ano}:r:${rc.chave}:${mm}`, tipo: "entrada", categoria: rc.cat,
        descricao: label.replace(/^Recebimento\s*/i, "").trim() + " (planilha)", valor: +v.toFixed(2),
        data: `${ano}-${mm}-01`, competencia: `${ano}-${mm}-01`, escopo: "empresa", produto_id: pid, pago: true }); });
  }
  for (const { grupo, label, vals } of dados.despesas) {
    const nome = limparItem(label), dia = diaDoItem(label), c = classificar(grupo!, label);
    usadas.push({ nome: c.cat, matriz: c.mat, tipo: "despesa", escopo: c.esc });
    vals.forEach((v, m) => { if (m > mesMax || v == null || v <= 0) return; const mm = String(m + 1).padStart(2, "0");
      const ult = new Date(Date.UTC(ano, m + 1, 0)).getUTCDate(), d = String(Math.min(dia || 10, ult)).padStart(2, "0"), data = `${ano}-${mm}-${d}`;
      const id = `pl:${ano}:d:${slug(nome)}:${mm}`;
      const rep = todas.find((l) => l.origem_id === id); if (rep) { rep.valor = +(rep.valor + v).toFixed(2); return; }
      todas.push({ origem: "planilha", origem_id: id, tipo: "despesa", categoria: c.cat, descricao: /cart/i.test(grupo!) ? "Fatura " + nome : nome, valor: +v.toFixed(2),
        data, competencia: `${ano}-${mm}-01`, escopo: c.esc === "ambos" ? "pessoal" : c.esc, produto_id: null, pago: data <= H.iso }); });
  }
  if (!todas.length) return "nenhum valor até o mês atual";
  await garantirCategorias(cats || [], usadas);

  const { data: ex, error: e0 } = await sb.from("lancamentos").select("id,origem_id,valor").eq("origem", "planilha");
  if (e0) throw new Error(e0.message);
  const mapa = new Map((ex || []).map((x) => [x.origem_id, x]));
  const ids = new Set(todas.map((l) => l.origem_id));
  const novos = todas.filter((l) => !mapa.has(l.origem_id));
  const mudados = todas.filter((l) => mapa.has(l.origem_id) && Math.abs(+mapa.get(l.origem_id)!.valor - l.valor) > 0.005);
  const sobras = (ex || []).filter((x) => x.origem_id && x.origem_id.startsWith(`pl:${ano}:`) && !ids.has(x.origem_id) && (+x.origem_id.slice(-2) - 1) <= mesMax);

  // linha do tempo: o que mudou na receita (a primeira importação não conta)
  const nomeMes = (l: Reg) => MESES[+String(l.origem_id).slice(-2) - 1];
  const avisos = (ex || []).length ? [
    ...mudados.filter((l) => l.tipo === "entrada").map((l) => { const de = +mapa.get(l.origem_id)!.valor, dif = l.valor - de;
      return `Planilha: ${String(l.descricao).replace(" (planilha)", "")} de ${nomeMes(l)} foi de ${rs(de)} para ${rs(l.valor)} (${dif > 0 ? "+" : "−"}${rs(Math.abs(dif))})`; }),
    ...novos.filter((l) => l.tipo === "entrada").map((l) => `Planilha: ${String(l.descricao).replace(" (planilha)", "")} de ${nomeMes(l)} entrou com ${rs(l.valor)}`),
  ].slice(0, 6) : [];

  if (novos.length) { const { error } = await sb.from("lancamentos").upsert(novos, { onConflict: "origem_id" }); if (error) throw new Error(error.message); }
  for (const l of mudados) { const { error } = await sb.from("lancamentos").update({ valor: l.valor }).eq("id", mapa.get(l.origem_id)!.id); if (error) throw new Error(error.message); }
  if (sobras.length) { const { error } = await sb.from("lancamentos").delete().in("id", sobras.map((x) => x.id)); if (error) throw new Error(error.message); }

  let nMetas = 0;
  if (dados.metas) {
    const metas = dados.metas.map((v, m) => v && v > 0 ? { ano_mes: `${ano}-${String(m + 1).padStart(2, "0")}`, total: +v.toFixed(2) } : null)
      .filter((x): x is { ano_mes: string; total: number } => !!x)
      .filter((x) => { const a = (metasAtuais || []).find((y) => y.ano_mes === x.ano_mes); return !a || Math.abs(+a.total - x.total) > 0.005; });
    if (metas.length) { const { error } = await sb.from("metas_mes").upsert(metas, { onConflict: "ano_mes" }); if (error) throw new Error("metas: " + error.message); nMetas = metas.length; }
  }
  if (avisos.length) await sb.from("eventos").insert(avisos.map((t) => ({ origem: "planilha", tipo: "planilha", titulo: t })));

  const p: string[] = [];
  if (novos.length) p.push(`${novos.length} novos`); if (mudados.length) p.push(`${mudados.length} atualizados`);
  if (sobras.length) p.push(`${sobras.length} removidos`); if (nMetas) p.push(`${nMetas} meta${nMetas > 1 ? "s" : ""}`);
  return p.length ? p.join(", ") : "sem mudanças";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  const { data: seg } = await sb.from("assessor_segredos").select("valor").eq("chave", "cron").maybeSingle();
  if (!seg?.valor || req.headers.get("x-rhino-cron") !== seg.valor) return json({ erro: "não autorizado" }, 401);
  try {
    const resumo = await sincronizar();
    return json({ ok: true, resumo, quando: new Date().toISOString() });
  } catch (e) {
    const msg = String((e as Error).message || e);
    await sb.from("eventos").insert({ origem: "sistema", tipo: "planilha", titulo: "A sincronização automática da planilha falhou: " + msg.slice(0, 180) });
    return json({ erro: msg }, 500);
  }
});
