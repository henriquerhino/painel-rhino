# Assessor Rhino no WhatsApp — como ligar

O assessor já está publicado no Supabase (função `assessor`) e testado com os seus dados. Falta só ligar o WhatsApp oficial da Meta. **Chaves e tokens são colados por você**, direto no cofre do Supabase; ninguém mais precisa vê-los.

Tempo: uns 40 minutos para funcionar com o **número de teste** da Meta (mesmo dia). O número definitivo da Rhino pode vir depois, sem refazer nada.

## O que você vai precisar
- Seu login do Facebook (para entrar em developers.facebook.com).
- Seu WhatsApp pessoal (é de onde você vai conversar com o assessor).
- Depois, para o número definitivo: um chip ou número que **não** esteja em uso no WhatsApp.

## Passo 1 · Criar o app na Meta
1. Entre em **developers.facebook.com** → *Meus apps* → *Criar app*.
2. Caso de uso: **Outro** → tipo **Empresa** (Business). Dê o nome "Assessor Rhino". Se pedir um portfólio empresarial, crie um com o nome da empresa.
3. Dentro do app, adicione o produto **WhatsApp**. A Meta cria sozinha uma conta do WhatsApp Business e um **número de teste**.
4. Em *WhatsApp → Configuração da API* (API Setup):
   - anote o **Phone number ID** (identificação do número de telefone);
   - em "Para" (To), **adicione o seu WhatsApp** como destinatário e confirme o código que chega nele. O número de teste só conversa com até 5 números cadastrados ali.

## Passo 2 · Gerar o token permanente
O token que aparece na tela de configuração vale só 24 horas. O permanente é assim:
1. Abra **business.facebook.com/settings** → *Usuários* → **Usuários do sistema** → *Adicionar* → nome "assessor", função **Administrador**.
2. Em *Atribuir ativos*, dê a esse usuário **controle total** do app "Assessor Rhino" e da conta do WhatsApp.
3. Clique em **Gerar token** → escolha o app → validade **Nunca** → marque `whatsapp_business_messaging` e `whatsapp_business_management` → gerar. Copie o token (ele só aparece uma vez).
4. Ainda na Meta: no app, *Configurações do app → Básico* → copie a **Chave secreta do app** (App secret).

## Passo 3 · Colar os segredos no Supabase
Supabase → projeto **Painel Financeiro RHINO** → *Edge Functions* → **Secrets** → *Add new secret*:

| Nome | O que colar |
|---|---|
| `WHATSAPP_TOKEN` | o token permanente do passo 2 |
| `WHATSAPP_PHONE_ID` | o Phone number ID do passo 1 |
| `WHATSAPP_APP_SECRET` | a chave secreta do app |
| `WHATSAPP_VERIFY_TOKEN` | uma frase inventada por você, sem espaços (ex.: `rhino-2026-abacaxi`) |

A chave da IA (`ANTHROPIC_API_KEY`) já está lá.

## Passo 4 · Apontar o webhook
No app da Meta: *WhatsApp → Configuração* → **Webhook** → *Editar*:
- **URL de retorno:** `https://fcwxkelokmqwmivjembv.supabase.co/functions/v1/assessor`
- **Token de verificação:** a mesma frase do `WHATSAPP_VERIFY_TOKEN`
- *Verificar e salvar*. Depois, em **Campos do webhook**, assine **messages**.

(Faça o passo 3 antes: a verificação só passa com o segredo já salvo.)

## Passo 5 · Autorizar o seu número no painel
Painel → *Configurações* → **Assessor no WhatsApp** → seu nome e WhatsApp com DDD → *Autorizar número*. O assessor ignora qualquer número fora dessa lista.

## Passo 6 · Testar
Mande para o número de teste, do seu WhatsApp:
- "quanto entrou esse mês?"
- "quem tá me devendo?"
- "lança 35 de Uber, paguei hoje" → ele mostra o que entendeu → **Confirmar** → recibo com **Desfazer**.

## Passo 7 · Relatórios automáticos (modelo de mensagem)
A Meta só deixa mandar mensagem "do nada" se você falou com o assessor nas últimas 24 horas. Fora disso precisa de um **modelo aprovado**. Crie um só, em *Gerenciador do WhatsApp → Modelos de mensagem*:
- **Nome:** `resumo_pronto` · **Categoria:** Utilidade · **Idioma:** Português (BR)
- **Corpo:** `Bom dia, {{1}}. Seu resumo do Painel Rhino está pronto. Toque no botão para receber.` (exemplo para {{1}}: Henrique)
- **Botão** de resposta rápida: `Ver resumo`

Com isso: 07:30 de segunda a sábado chega o bom dia, sexta 18:00 o fechamento da semana e dia 1 o fechamento do mês. Se você conversou nas últimas 24 h, o relatório chega inteiro direto; senão chega o modelo e o botão entrega o relatório.

## Passo 8 · Áudio (opcional)
Crie uma chave em **console.groq.com** (ou na OpenAI) e cole no Supabase como `GROQ_API_KEY` (ou `OPENAI_API_KEY`). Sem ela o assessor responde pedindo texto.

## Depois: o número definitivo da Rhino
Em *Configuração da API → Adicionar número de telefone*: nome de exibição "Assessor Rhino", verificação por SMS ou ligação. Troque o `WHATSAPP_PHONE_ID` no Supabase pelo do número novo. Para falar com alunos (lembretes de cobrança), a Meta pede a **verificação da empresa** e modelos aprovados; fazemos quando chegar nessa etapa.

## O que já funciona e o que vem a seguir
- Funciona: perguntas sobre o mês, metas, recebíveis, contratos, despesas, cartões e linha do tempo; ações com confirmação e Desfazer (dar baixa, baixa parcial, lançar despesa, marcar paga, encerrar e renovar contrato); foto de comprovante ou boleto; relatórios automáticos.
- A seguir: Google Agenda e Meet (marcar call, "o que tenho hoje?", calls contadas sozinhas) e os lembretes automáticos para alunos.
