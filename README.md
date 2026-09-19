# Painel RHINO — Consulting Framework

Painel financeiro do Team Rhino: um único `index.html` (sem build, sem servidor) que roda no GitHub Pages, guarda os dados no **Supabase** e lê a planilha **PLANILHA FINANCEIRA E RESULTADOS 2026** do Google sozinho, toda vez que abre.

Abas: **Dashboard · Contratos · Recebíveis · Despesas · Lançamentos · Cartões · Investimentos · Configurações**. Visual escuro (fundo preto, cartões de vidro, botões-pílula). No Dashboard a **meta semanal** é um widget que passa de semana em semana (4 semanas em mês de 28 dias, 5 nos outros). No celular a navegação fica na barra de baixo e o botão **Mais** abre o menu de tela cheia (onde também fica o **Sair**).

### Contratos — ciclo de vida
Um cartão por contrato. Quando o contrato vence (ou faltam 30 dias), o cartão pergunta o que aconteceu, com três botões grandes:

| Botão | O que faz | O que acontece com o histórico |
|---|---|---|
| **Renovou** | abre o formulário de renovação (valor cheio, entrada, duração, parcelas) e cria um **contrato novo** do mesmo mentorado, ligado ao anterior (`renovacao_de`). O anterior vira *renovado*. | intacto — as parcelas pagas do contrato antigo continuam nele; o novo aparece com a faixa **Renovação** e um link para o anterior |
| **Não renovou** | encerra o contrato (*concluido*, com `encerrado_em`) | intacto — parcelas em aberto, se houver, continuam em Recebíveis para cobrança |
| **Cancelou** | cancela (*cancelado*, com `encerrado_em`) | o que foi pago fica; as parcelas em aberto deixam de ser cobradas e saem de Recebíveis |

Nada é apagado, e o faturamento dos meses vem da planilha — então encerrar, cancelar ou renovar nunca muda o que já foi faturado. Fora do vencimento, o botão **Renovar / encerrar** abre a mesma decisão; **Reativar** desfaz. Filtros: Ativos · Precisam de ação · Quitados · Renovados · Não renovaram · Cancelados · Todos.

### Recebíveis — baixa sem duplicidade
- Nos meses que a planilha traz, **o faturamento é o da planilha**. Dar baixa numa parcela só a tira da cobrança e guarda a data em que o dinheiro entrou; não soma de novo (veja `caixaMes`). Se o mês ainda não está na planilha, a baixa conta como recebido até a planilha trazer o mês.
- **Dar baixa** abre uma janela: data do recebimento (hoje / no vencimento / outra) e valor recebido. Valor menor que a parcela = **baixa parcial**: o restante vira uma parcela em aberto com o mesmo vencimento.
- **Conferência com a planilha**: o painel lê a aba de alunos (`PLANILHA.gidAlunos`, um aluno por linha, meses nas colunas) só em memória. Para cada parcela vencida, se a planilha mostra no mês do vencimento um valor que as baixas ainda não explicam, ela aparece como sugestão: **Já recebi** (baixa na data do vencimento), **Recebi parte** ou **Ainda não** (esconde a sugestão neste navegador). Nunca dá baixa sozinho — no mês em andamento a planilha mistura o que entrou com o que está previsto.
- No widget semanal, a soma das semanas nunca passa do total da planilha.
- Em Lançamentos, digitar uma **entrada** num mês que já vem da planilha pede confirmação (para não contar o mesmo dinheiro duas vezes).

### Despesas — lista segmentada
As despesas do mês ficam em **grupos** (Cartões, Despesas fixas, Colaboradores, Impostos…), do maior para o menor: cada grupo mostra total, % do mês, quanto falta pagar e uma barra do que já foi pago; dentro dele, as linhas em ordem de vencimento com **Pagar / Desfazer** e **Editar** (abre os campos na própria linha). Clique no título para recolher; **Recolher tudo** fecha todos. Filtrando por um grupo, as seções passam a ser as categorias dele. Itens vindos da planilha têm o valor travado.

### Cartões — edição segura
“Ver compras” lista parcelamentos e assinaturas **só para leitura**. **Editar** na linha abre um bloco com todos os campos (descrição, valor, total de parcelas, mês da 1ª parcela, categoria, cartão, escopo; assinatura: valor, cartão, ativa/pausada) e só grava em **Salvar**. Compras quitadas/futuras e assinaturas pausadas ficam em “fora da fatura deste mês”.

### Dashboard — o que pede ação hoje
- **Pendências de hoje**: uma lista só, com o botão que resolve cada item — contratos vencidos ou vencendo, parcelas vencidas (e quantas batem com a planilha), contas atrasadas ou que vencem em 3 dias, fixos não lançados, fatura de cartão chegando e itens da planilha muito acima da média de 3 meses.
- **Comparativo e projeção**: despesas contra o mês anterior, quanto o mês anterior fechou, "se o que falta entrar" (recebido + parcelas que ainda vencem, descontando o que a aba de alunos já mostra como pago) e o **saldo projetado do mês**.
- **Linha do tempo**: baixas, renovações, encerramentos, cobranças, mudanças de receita vindas da planilha e o que o assessor fez (tabela `eventos`).

### Cobrança com 1 toque
Em Recebíveis, **Quem me deve** agrupa as parcelas vencidas por pessoa. **Cobrar no WhatsApp** abre a conversa com a mensagem pronta (texto e chave PIX em Configurações; o WhatsApp do aluno fica no cadastro dele). O painel anota a data da cobrança; quem envia é você.

### Assessor no WhatsApp e rotinas do servidor
- Função `planilha`: a mesma sincronização do painel, rodando no servidor de hora em hora (pg_cron).
- `gravar_fechamento()`: no dia 1 grava o fechamento do mês anterior em `fechamentos`.
- Função `assessor`: WhatsApp oficial da Meta. Responde com os números do painel, propõe ações e só grava depois do **Confirmar** (com **Desfazer** por 24 h), lê foto de comprovante ou boleto e manda os relatórios automáticos. Só atende os números autorizados em Configurações. Passo a passo para ligar: [ASSESSOR-WHATSAPP.md](ASSESSOR-WHATSAPP.md).

### Agenda — Google Agenda e calls dos mentorados
A aba **Agenda** mostra a semana do Google Agenda, liga cada compromisso ao mentorado (pelo nome no título ou porque foi o assessor que marcou) e avisa quem está há mais de 30 dias sem call. De 3 em 3 horas o servidor confere as calls que já aconteceram e soma 1 em `calls_feitas` (tabela `calls`, uma linha por evento contado). A conexão é feita na própria aba, em 4 passos: copiar o código de `google-agenda-ponte.gs` para um projeto do Apps Script na conta do dono, adicionar o serviço Google Calendar API, implantar como App da Web e colar o endereço `/exec` no painel. A chave da ponte nasce no servidor (função `agenda`) nesse momento e ninguém a vê. Pelo WhatsApp o assessor responde "o que eu tenho hoje?", acha horário livre e marca, remarca ou cancela com confirmação, link do Meet e aviso de conflito.

### Lançamentos
Resumo do período (entradas, saídas, resultado, quantidade), atalhos **Tudo · Entradas · Saídas · A pagar · Da planilha · Digitados aqui**, busca, e o filtro de período/grupo + relatório em PDF recolhido. Linhas da planilha têm valor travado e não têm ✕.

---

## Como os dados entram

| De onde | O que | Como |
|---|---|---|
| **Planilha do Google** (aba financeira) | receitas por origem (Consultoria, Mentoria, Framework), despesas por grupo e item, meta do mês (linha *Objetivo*) | automático, ao abrir o painel (e no botão **Atualizar**) |
| **Planilha do Google** (aba de alunos) | quanto cada aluno aparece pagando em cada mês | só leitura, em memória, para a conferência de Recebíveis |
| **Painel** | contratos, parcelas, cartões, parcelamentos, assinaturas, fixos, carteiras, análises da IA | digitado nas abas |
| **Edge Function** (opcional) | análise com IA e leitura de fatura por print | URL em *Configurações → URL do agente* |

### Sincronização com a planilha
- A planilha precisa estar compartilhada como **qualquer pessoa com o link · leitor**. O painel lê o CSV público da aba pelo endpoint `gviz` (não precisa de chave, senha nem servidor).
- **A planilha é a fonte dos números do mês.** Entram as três receitas (*Recebimento Consultoria / Mentoria / FRAMEWORK*), todas as despesas e a meta (linha *Objetivo*). Nos meses em que a planilha tem receita, o “Recebido” do Dashboard é o dela; as parcelas baixadas no painel continuam valendo para cobrança (Recebíveis), mas não somam de novo.
- Todos os itens de despesa entram, inclusive *Provisões financeiras* (categoria Provisões financeiras) e *Carteira de investimentos* (categoria Investimentos) — o total do painel é a soma de todos os itens da planilha.
- Só entram **meses até o mês atual**; o restante da planilha é projeção.
- Lançamentos digitados no painel nunca são tocados — por isso não digite no painel o que já está na planilha, ou o valor aparece duas vezes. O painel é para o que a planilha não tem: contratos, parcelas, cartões, investimentos e lançamentos avulsos.
- Cada célula vira um lançamento com etiqueta **planilha** e um id estável (`pl:2026:d:aluguel-sp:07`). Assim a sincronização nunca duplica.
- Linha nova: entra completa (situação *pago* quando a data já passou; a data é o dia que aparece no nome do item, ex. `Aluguel SP - 05`). Linha existente: **só o valor** acompanha a planilha; situação, categoria e descrição editadas no painel ficam.
- Célula apagada na planilha: o lançamento é removido. Lançamentos digitados no painel nunca são tocados.
- Receitas entram no dia 1 do mês (a planilha só tem o total mensal).
- Categorias seguem o esquema que já existe no painel (*Despesas fixas · Pessoal*, *Cartões · empresa*, *Colaboradores*, *Impostos*, *Provisões financeiras*…); o item da planilha vai na descrição. Só cria categoria se faltar.
- Para trocar a planilha, as abas ou quais receitas entram, edite a constante `PLANILHA` no topo do `index.html` (`id`, `gid`, `gidAlunos`, `ano`, `receitas`).

---

## Instalação e atualizações

1. **Supabase**: rode, no SQL Editor, os arquivos de migração que ainda não rodou:
   - `supabase-migracao-v5-planilha.sql` — `origem` e `origem_id` em `lancamentos` (sincronização com a planilha);
   - `supabase-migracao-v6-renovacao.sql` — `renovacao_de` e `encerrado_em` em `contratos` (renovação e encerramento). *Já aplicada no projeto em 18/09/2026.*
   - `supabase-migracao-v7-assessor.sql` — cobrança, `eventos`, `fechamentos`, tabelas do assessor e os agendamentos. *Já aplicada.* O código das funções está em `supabase/functions/`.
2. **GitHub Pages**: suba o `index.html` (Add file → Upload files → Commit). O site atualiza em ~1 minuto.
3. Abra o painel, entre, e confira no Dashboard o status **“Planilha sincronizada às …”**. Em *Configurações → Planilha do Google* estão o ID, as abas e a última sincronização.

---

## Privacidade

O site no GitHub Pages é público, mas os dados só aparecem depois do login (Supabase Auth). A planilha, para ser lida pelo painel, fica **legível por link** — quem tiver o link dela consegue abrir. Se isso incomodar, a alternativa é publicar só as abas usadas (*Arquivo → Compartilhar → Publicar na web*) e manter a planilha principal privada.

---

## Estrutura do código (`index.html`)

- `<style>`: visual escuro, tokens em `:root`, regras de celular em `@media(max-width:720px)`.
- `PLANILHA`, `SUPABASE_*`: configurações.
- Cálculos (`caixaMes`, `despesasMes`, `semanas`…), agente local e chamada da IA.
- Uma função `ver…()` por aba; `desenhar()` redesenha a aba ativa e rotula as tabelas restantes para o celular.
  - Contratos: `dadosContrato`, `cardContrato`, `barraDecisao`, `formRenovacao`, `criarRenovacao`, `encerrarContrato`, `reativarContrato`.
  - Recebíveis: `abrirBaixa` / `confirmarBaixa` / `gravarBaixa` (janela de baixa), `sugestoesPlanilha` / `blocoConferencia` (conferência com a aba de alunos).
  - Despesas: `secaoDespesas` / `linhaDespesa` (lista segmentada). Cartões: `linhaCompra` / `linhaAssinatura` / `salvarCompra` / `salvarAssinatura`.
- Bloco **PLANILHA**: `csvParse`, `lerFinanceira`, `gravarPlanilha`, `sincronizarPlanilha`, e `lerAlunos` / `lerAbaAlunos` (aba de alunos, só leitura).

Tabelas no Supabase: `config, produtos, mentorados, contratos, parcelas, lancamentos, recorrencias, cartoes, parcelamentos, assinaturas, metas_mes, investimentos, investimentos_hist, categorias, analises, eventos, fechamentos, assessor_contatos, assessor_mensagens, assessor_pendentes, assessor_segredos` (esta última só o servidor lê). A tabela `repasses` (sociedade encerrada) não é mais usada pelo painel.

`app.html` é uma versão antiga e não é usada pelo site.
