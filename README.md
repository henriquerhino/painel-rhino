# Painel RHINO — Consulting Framework

Painel financeiro do Team Rhino: um único `index.html` (sem build, sem servidor) que roda no GitHub Pages, guarda os dados no **Supabase** e lê a planilha **PLANILHA FINANCEIRA E RESULTADOS 2026** do Google sozinho, toda vez que abre.

Abas: **Dashboard · Contratos · Recebíveis · Despesas · Lançamentos · Cartões · Investimentos · Configurações**. Tudo editável direto na tela; no celular as tabelas viram listas e a navegação fica na barra de baixo.

---

## Como os dados entram

| De onde | O que | Como |
|---|---|---|
| **Planilha do Google** (aba financeira) | receitas por origem (Consultoria, Mentoria, Framework), despesas por grupo e item, meta do mês (linha *Objetivo*) | automático, ao abrir o painel (e no botão **Atualizar**) |
| **Painel** | contratos, parcelas, cartões, parcelamentos, assinaturas, fixos, carteiras, repasses, análises da IA | digitado nas abas |
| **Edge Function** (opcional) | análise com IA e leitura de fatura por print | URL em *Configurações → URL do agente* |

### Sincronização com a planilha
- A planilha precisa estar compartilhada como **qualquer pessoa com o link · leitor**. O painel lê o CSV público da aba pelo endpoint `gviz` (não precisa de chave, senha nem servidor).
- Só entram **meses até o mês atual**; o restante da planilha é projeção.
- Cada célula vira um lançamento com etiqueta **planilha** e um id estável (`pl:2026:d:aluguel-sp:09`). Assim a sincronização nunca duplica.
- Linha nova: entra completa (situação *pago* quando a data já passou; a data é o dia que aparece no nome do item, ex. `Aluguel SP - 05`). Linha existente: **só o valor** acompanha a planilha; situação, categoria e descrição editadas no painel ficam.
- Célula apagada na planilha: o lançamento é removido. Lançamentos digitados no painel nunca são tocados.
- Receitas entram no dia 1 do mês (a planilha só tem o total mensal). A meta do mês vem da linha *Objetivo*.
- Categorias são criadas automaticamente: matrizes **Casa & fixos**, **Cartões**, **Colaboradores & ferramentas**, **Extras & provisões** e **Receitas**, com um item por linha da planilha. Ajuste escopo (empresa/pessoal) e organização em *Configurações → Categorias*.
- Para trocar a planilha ou a aba, edite a constante `PLANILHA` no topo do `index.html` (`id`, `gid` da aba, `ano`).

> Se a planilha e o painel forem usados para lançar a **mesma** despesa, ela aparece duas vezes. Combine: quem lança na planilha não lança no painel (e vice-versa).

---

## Instalação e atualizações

1. **Supabase**: rode, no SQL Editor, os arquivos de migração que ainda não rodou. Para esta versão: `supabase-migracao-v5-planilha.sql` (cria `origem` e `origem_id` em `lancamentos`).
2. **GitHub Pages**: suba o `index.html` (Add file → Upload files → Commit). O site atualiza em ~1 minuto.
3. Abra o painel, entre, e confira no Dashboard o status **“Planilha sincronizada às …”**. Em *Configurações → Planilha do Google* estão o ID, a aba e a última sincronização.

---

## Privacidade

O site no GitHub Pages é público, mas os dados só aparecem depois do login (Supabase Auth). A planilha, para ser lida pelo painel, fica **legível por link** — quem tiver o link dela consegue abrir. Se isso incomodar, a alternativa é publicar só a aba financeira (*Arquivo → Compartilhar → Publicar na web*) e manter a planilha principal privada.

---

## Estrutura do código (`index.html`)

- `<style>`: visual claro (versão “Clara”), tokens em `:root`, regras de celular em `@media(max-width:720px)`.
- `PLANILHA`, `SUPABASE_*`: configurações.
- Cálculos (`caixaMes`, `despesasMes`, `semanas`, `repasseAno`…), agente local e chamada da IA.
- Uma função `ver…()` por aba; `desenhar()` redesenha a aba ativa e rotula as tabelas para o celular.
- Bloco **PLANILHA**: `csvParse`, `lerFinanceira`, `gravarPlanilha`, `sincronizarPlanilha`.

Tabelas no Supabase: `config, produtos, mentorados, contratos, parcelas, lancamentos, recorrencias, cartoes, parcelamentos, assinaturas, metas_mes, investimentos, investimentos_hist, categorias, repasses, analises`.

`app.html` é uma versão antiga e não é usada pelo site.
