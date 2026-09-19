// PAINEL RHINO · Edge Function "agenda"
// Conversa com o Google Agenda por uma ponte em Google Apps Script que roda na conta do dono
// (arquivo google-agenda-ponte.gs). Quem chama: o painel (usuário logado) e o assessor / agendador
// (cabeçalho x-rhino-cron). A chave da ponte é criada aqui, na hora de conectar, e só o servidor a lê.
import { createClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Reg = Record<string, any>;
const env = (k: string) => Deno.env.get(k) ?? "";
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-rhino-cron", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const norm = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const FUSO = "-03:00"; // São Paulo, sem horário de verão
const comFuso = (s: string) => /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : s.slice(0, 19).padEnd(19, ":00").slice(0, 19) + FUSO;
const hojeSP = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

async function quemChama(req: Request): Promise<"interno" | "usuario" | null> {
  const cron = req.headers.get("x-rhino-cron");
  if (cron) { const { data } = await sb.from("assessor_segredos").select("valor").eq("chave", "cron").maybeSingle(); return data?.valor && data.valor === cron ? "interno" : null; }
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""); if (!tok) return null;
  const { data, error } = await sb.auth.getUser(tok); return !error && data?.user ? "usuario" : null;
}
async function segredos() {
  const { data } = await sb.from("assessor_segredos").select("chave,valor").in("chave", ["google_url", "google_chave", "google_agenda"]);
  const v = (k: string) => data?.find((x) => x.chave === k)?.valor || ""; return { url: v("google_url"), chave: v("google_chave"), nome: v("google_agenda") };
}
async function falar(url: string, corpo: Reg) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(corpo), redirect: "follow" });
  const t = await r.text(); let j: Reg;
  try { j = JSON.parse(t); } catch { throw new Error(/accounts\.google|<html/i.test(t) ? "a ponte não está publicada com acesso “Qualquer pessoa”" : "a ponte respondeu algo inesperado"); }
  if (j.erro) throw new Error(j.erro); return j;
}
async function ponte(corpo: Reg) { const s = await segredos(); if (!s.url || !s.chave) throw new Error("Google Agenda ainda não conectado"); return await falar(s.url, { ...corpo, chave: s.chave }); }

/** Liga o evento a um mentorado: pelo id gravado pelo assessor ou pelo nome no título (nome inteiro, ou primeiro + último nome). */
function casar(ev: Reg, mentorados: Reg[]) {
  if (ev.mentorado_id) { const m = mentorados.find((x) => x.id === ev.mentorado_id); if (m) return m; }
  const t = " " + norm(ev.titulo) + " ";
  const c = mentorados.filter((m) => { const n = norm(m.nome), p = n.split(" ").filter((x) => x.length > 2); if (p.length < 2) return false; return t.includes(" " + n + " ") || (t.includes(" " + p[0] + " ") && t.includes(" " + p[p.length - 1] + " ")); });
  return c.length === 1 ? c[0] : null;
}
async function listar(de: string, ate: string) {
  const [{ eventos }, { data: mentorados }] = await Promise.all([ponte({ acao: "listar", de: comFuso(de), ate: comFuso(ate) }), sb.from("mentorados").select("id,nome,calls_feitas,calls_contratadas")]);
  return (eventos as Reg[]).map((ev) => { const m = casar(ev, mentorados || []); return { ...ev, mentorado: m ? { id: m.id, nome: m.nome, calls: `${m.calls_feitas || 0}/${m.calls_contratadas || 0}` } : null }; });
}
async function livres(dia: string, duracaoMin: number) {
  const evs = (await listar(`${dia}T00:00:00`, `${dia}T23:59:59`)).filter((e) => !e.dia_inteiro).map((e) => [Date.parse(e.inicio), Date.parse(e.fim)]).sort((a, b) => a[0] - b[0]);
  const ini = Date.parse(`${dia}T08:00:00${FUSO}`), fim = Date.parse(`${dia}T20:00:00${FUSO}`), out: { de: string; ate: string }[] = []; let cursor = Math.max(ini, dia === hojeSP() ? Date.now() : ini);
  const hhmm = (t: number) => new Date(t - 3 * 3600 * 1000).toISOString().slice(11, 16);
  for (const [a, b] of [...evs, [fim, fim]]) { if (a - cursor >= duracaoMin * 60000) out.push({ de: hhmm(cursor), ate: hhmm(Math.min(a, fim)) }); cursor = Math.max(cursor, b); if (cursor >= fim) break; }
  return out;
}
async function contarCalls() {
  const s = await segredos(); if (!s.url) return { ok: false, motivo: "Google Agenda não conectado" };
  const agora = Date.now(), evs = await listar(new Date(agora - 36 * 3600 * 1000).toISOString(), new Date(agora).toISOString());
  const feitas = evs.filter((e) => e.mentorado && !e.dia_inteiro && Date.parse(e.fim) < agora && Date.parse(e.fim) - Date.parse(e.inicio) >= 15 * 60000);
  let novas = 0;
  for (const e of feitas) {
    const { error } = await sb.from("calls").insert({ evento_id: e.id, mentorado_id: e.mentorado.id, titulo: e.titulo, inicio: e.inicio, fim: e.fim }); if (error) continue; // já contada
    const { data: total } = await sb.rpc("somar_call", { p_mentorado: e.mentorado.id }); novas++;
    await sb.from("eventos").insert({ origem: "sistema", tipo: "call", titulo: `Call com ${e.mentorado.nome} contada pela agenda${total != null ? ` · agora ${total} feitas` : ""}`, ref_tabela: "mentorados", ref_id: e.mentorado.id });
  }
  return { ok: true, conferidas: feitas.length, novas };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);
  const quem = await quemChama(req); if (!quem) return json({ erro: "não autorizado" }, 401);
  try {
    const b: Reg = JSON.parse((await req.text()) || "{}");
    if (b.acao === "status") { const s = await segredos(); return json({ conectada: !!(s.url && s.chave), agenda: s.nome || null }); }
    if (b.acao === "conectar") {
      const url = String(b.url || "").trim(); if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) return json({ erro: "Cole o endereço do app da Web, que termina em /exec." }, 400);
      const antiga = (await segredos()).chave, chave = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const r = await falar(url, { acao: "configurar", chave, chave_antiga: antiga || undefined });
      const { error } = await sb.from("assessor_segredos").upsert([{ chave: "google_url", valor: url }, { chave: "google_chave", valor: chave }, { chave: "google_agenda", valor: String(r.agenda || "Google Agenda") }], { onConflict: "chave" }); if (error) throw new Error(error.message);
      await sb.from("eventos").insert({ origem: "sistema", tipo: "agenda", titulo: `Google Agenda conectado (${r.agenda || "agenda principal"})` });
      return json({ ok: true, agenda: r.agenda || null });
    }
    if (b.acao === "desconectar") { await sb.from("assessor_segredos").delete().in("chave", ["google_url", "google_chave", "google_agenda"]); return json({ ok: true }); }
    if (b.acao === "listar") return json({ eventos: await listar(String(b.de), String(b.ate)) });
    if (b.acao === "livre") return json({ dia: b.dia, livres: await livres(String(b.dia), Math.max(15, +b.duracao_min || 60)) });
    if (b.acao === "criar") { const r = await ponte({ acao: "criar", titulo: String(b.titulo || "Reunião"), descricao: b.descricao || "", inicio: comFuso(String(b.inicio)), fim: comFuso(String(b.fim)), convidados: b.convidados || [], meet: b.meet !== false, mentorado_id: b.mentorado_id || "" }); return json(r); }
    if (b.acao === "mover") return json(await ponte({ acao: "mover", id: String(b.id), inicio: comFuso(String(b.inicio)), fim: comFuso(String(b.fim)) }));
    if (b.acao === "cancelar") return json(await ponte({ acao: "cancelar", id: String(b.id) }));
    if (b.acao === "contar_calls") return json(await contarCalls());
    return json({ erro: "ação desconhecida" }, 400);
  } catch (e) { return json({ erro: String((e as Error).message || e) }, 500); }
});
