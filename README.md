# Painel Financeiro — Team Rhino + Framework

Dashboard que lê a planilha **PLANILHA FINANCEIRA E RESULTADOS 2026** (Aba 1 = despesas/entradas, Aba 2 = alunos e fluxo) e mostra receita, despesa, resultado, alunos e metas. Ele tenta ler a planilha **ao vivo**; se não conseguir, usa um **snapshot** embutido no próprio arquivo.

O arquivo `index.html` é autossuficiente: um HTML só, sem instalação, sem servidor.

---

## ⚠️ Antes de tudo: privacidade

Um site no **GitHub Pages é público** — qualquer pessoa com o link acessa. E, para o painel ler a planilha ao vivo, a planilha precisa ficar **legível por link**. Ou seja: colocar isso no ar do jeito mais simples deixa seus números financeiros acessíveis a quem descobrir os links.

Três caminhos, do mais simples ao mais seguro:

1. **Público com link "difícil"** — rápido e grátis, mas os dados ficam expostos a quem tiver o endereço. Não recomendo para números de faturamento.
2. **Repositório privado + Pages** — o GitHub só serve Pages de repositório privado no plano **Pro** (pago). O site continua público, mas o código fica fechado.
3. **Hospedar com senha** (recomendado para dados sensíveis) — Netlify, Vercel ou Cloudflare Pages permitem proteger o site com login/senha. O passo a passo é parecido com o do GitHub. Me chama que eu te passo esse caminho.

Decida isso primeiro. O resto abaixo funciona igual nos três.

---

## Parte 1 — Conectar a planilha (deixar o painel "ao vivo")

Enquanto isso não for feito, o painel funciona com o snapshot (indicador amarelo "Snapshot local").

1. Abra a planilha no Google Sheets.
2. Botão **Compartilhar** → em "Acesso geral", troque para **Qualquer pessoa com o link** → papel **Leitor**.
3. Pronto. O painel já lê pelo ID que está configurado dentro do `index.html`:
   ```
   1WsgpupBx_CXdEf_zI1vUXjAemtuUQdGNJ2eje2Er4Sc
   ```
4. Recarregue o painel. O indicador no topo deve virar **verde "Ao vivo"**. O botão de atualizar (ícone de recarregar) puxa os números do momento.

> Não quer deixar a planilha inteira legível por link? Alternativa: em **Arquivo → Compartilhar → Publicar na Web**, publique **cada aba** no formato **CSV**, copie as duas URLs e cole em `CONFIG.urlResultado` e `CONFIG.urlFramework` no topo do `index.html`. Assim só as duas abas ficam expostas, não a planilha toda.

### Se você mudar a estrutura da planilha
O painel encontra os dados por **rótulo**, não por posição de célula. Então pode adicionar/remover alunos e linhas à vontade. Só mantenha os textos-âncora escritos assim:
`Recebimento Consultoria`, `Recebimento Mentoria`, `Recebimento FRAMEWORK`, as 4 linhas `Total` dos grupos de despesa, `TOTAL DAS DESPESAS`, `Objetivo`, `Realizado`, e os títulos `Mentoria RHINO` e `Mentoria FrameWork` seguidos de uma linha `TOTAL`.

---

## Parte 2 — Publicar no GitHub Pages

1. Crie uma conta em github.com (se ainda não tiver) e clique em **New repository**. Nome ex.: `painel-rhino`. Deixe **Public** (ou Private, se tiver Pro).
2. Na página do repositório: **Add file → Upload files**. Arraste o `index.html` (e este `README.md`). **Commit**.
3. Vá em **Settings → Pages**.
4. Em "Build and deployment", fonte **Deploy from a branch**, branch **main**, pasta **/ (root)**. **Save**.
5. Aguarde ~1 minuto. O endereço aparece no topo dessa mesma tela, algo como:
   ```
   https://SEU-USUARIO.github.io/painel-rhino/
   ```
6. Abra esse link. Se a planilha já estiver compartilhada (Parte 1), o painel abre "Ao vivo".

Para atualizar o painel depois, é só refazer o upload do `index.html` (ou editar pelo próprio GitHub).

---

## Como funciona por dentro (resumo)

- **Fonte de dados:** Google Sheets, lido via endpoint CSV (`gviz`) por nome de aba.
- **Reserva:** snapshot das duas abas embutido no HTML — o painel nunca fica em branco.
- **Aba 1 →** receita por origem, 4 grupos de despesa com itens, metas, resultado.
- **Aba 2 →** todos os alunos (Rhino + Framework), fluxo mês a mês, status, mensalidade, recebido no ano.
- **Mês padrão:** último mês fechado (agosto costuma estar parcial).

---

## Empresa x Pessoal

O painel separa cada despesa em **empresa** ou **pessoal** (equipe, Framework, impostos, ferramentas, contador, Aluguel REC = empresa; aluguel/financiamento SP, cartões PF, suplementos, terapia, moda, provisões = pessoal). Isso aparece na Visão Geral (donut + "lucro do negócio") e na aba Despesas.

Algumas classificações são chutes meus (ex.: "Vivo", "Cartão Visa Uso geral"). Na aba **Despesas**, clique na etiqueta **Empresa/Pessoal** de qualquer item para trocar — sua escolha fica salva no navegador (quando hospedado). O botão **Consolidado / Empresa** no topo alterna a leitura entre "tudo" e "só o negócio".

## Limitações honestas

- A planilha mistura pagamento adiantado e mensalidade no mesmo aluno, então "mensalidade" é uma **estimativa** (último pagamento). O número exato por aluno é o **recebido no ano**.
- A receita do topo soma só as 3 origens operacionais (Consultoria + Mentoria + Framework); as linhas de "CAIXA"/aportes ficam de fora para não inflar o faturamento.
- O painel é **somente leitura**. Quem lança continua sendo o time, na planilha.
