/**
 * PONTE GOOGLE AGENDA · Painel Rhino
 * Roda na SUA conta do Google e deixa o painel e o assessor lerem e marcarem compromissos.
 *
 * Como publicar (5 minutos, uma vez só):
 *  1. script.google.com  →  Novo projeto  →  apague o que estiver no editor e cole este arquivo inteiro.
 *  2. Na coluna da esquerda, em "Serviços", clique no +  →  "Google Calendar API"  →  Adicionar.
 *  3. Implantar  →  Nova implantação  →  tipo "App da Web"
 *        Executar como: Eu        Quem pode acessar: Qualquer pessoa        →  Implantar
 *  4. Autorizar acesso  →  escolha a sua conta  →  Avançado  →  Acessar o projeto  →  Permitir.
 *  5. Copie o "URL do app da Web" (termina em /exec) e cole no painel: Agenda → Conectar.
 *
 * Segurança: a primeira conexão grava uma chave secreta criada pelo servidor do painel.
 * Sem essa chave a ponte não responde a ninguém. Para desligar tudo: Implantar → Gerenciar
 * implantações → Arquivar.
 */
var PROP = PropertiesService.getScriptProperties();
var FUSO = 'America/Sao_Paulo';

function doGet() { return saida({ ok: true, ponte: 'Painel Rhino' }); }

function doPost(e) {
  var out;
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var atual = PROP.getProperty('CHAVE');
    if (b.acao === 'configurar') {
      if (atual && b.chave_antiga !== atual) throw new Error('esta ponte já está ligada a um painel');
      if (!b.chave || String(b.chave).length < 32) throw new Error('chave inválida');
      PROP.setProperty('CHAVE', String(b.chave));
      out = { ok: true, agenda: CalendarApp.getDefaultCalendar().getName() };
    } else {
      if (!atual || b.chave !== atual) throw new Error('não autorizado');
      out = executar(b);
    }
  } catch (err) { out = { erro: String((err && err.message) || err) }; }
  return saida(out);
}
function saida(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function executar(b) {
  var cal = 'primary';
  if (b.acao === 'listar') {
    var r = Calendar.Events.list(cal, { timeMin: b.de, timeMax: b.ate, singleEvents: true, orderBy: 'startTime', maxResults: 150 });
    return { eventos: (r.items || []).filter(function (ev) { return ev.status !== 'cancelled'; }).map(resumir) };
  }
  if (b.acao === 'criar') {
    var convidados = (b.convidados || []).map(function (email) { return { email: email }; });
    var ev = {
      summary: b.titulo, description: b.descricao || '',
      start: { dateTime: b.inicio, timeZone: FUSO }, end: { dateTime: b.fim, timeZone: FUSO },
      attendees: convidados, reminders: { useDefault: true },
      extendedProperties: { 'private': { rhino: '1', mentorado_id: b.mentorado_id || '' } }
    };
    if (b.meet !== false) ev.conferenceData = { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
    return { evento: resumir(Calendar.Events.insert(ev, cal, { conferenceDataVersion: 1, sendUpdates: convidados.length ? 'all' : 'none' })) };
  }
  if (b.acao === 'mover') {
    var m = Calendar.Events.patch({ start: { dateTime: b.inicio, timeZone: FUSO }, end: { dateTime: b.fim, timeZone: FUSO } }, cal, b.id, { sendUpdates: 'all' });
    return { evento: resumir(m) };
  }
  if (b.acao === 'cancelar') { Calendar.Events.remove(cal, b.id, { sendUpdates: 'all' }); return { ok: true }; }
  throw new Error('ação desconhecida');
}

function resumir(ev) {
  var priv = (ev.extendedProperties && ev.extendedProperties['private']) || {};
  return {
    id: ev.id, titulo: ev.summary || '(sem título)',
    inicio: ev.start.dateTime || ev.start.date, fim: ev.end.dateTime || ev.end.date, dia_inteiro: !ev.start.dateTime,
    meet: ev.hangoutLink || '', link: ev.htmlLink || '',
    convidados: (ev.attendees || []).map(function (a) { return a.email; }),
    mentorado_id: priv.mentorado_id || '', criado_pelo_assessor: !!priv.rhino
  };
}
