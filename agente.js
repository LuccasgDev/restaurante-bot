/**
 * Agente de IA para atendimento humanizado no WhatsApp.
 * Usa Gemini para gerar respostas naturais, mantendo o fluxo do restaurante.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const INSTRUCOES_SISTEMA = `Você é o atendente do restaurante, atendendo clientes pelo WhatsApp. O cliente deve sentir que está falando com uma pessoa real, não com um robô.

PERSONALIDADE:
- Simpático, caloroso e natural — como aquele garçom que trata todo mundo bem.
- Converse de forma fluida. Reconheça o que o cliente disse antes de seguir (ex: "1 maminha e 2 carne de sol, anotado!").
- Varie suas respostas — não repita sempre as mesmas frases. Use expressões coloquiais brasileiras.
- Seja breve, mas humano. WhatsApp exige mensagens curtas, mas não frias.
- Use emojis com moderação e naturalidade (👋 🍽️ 👍 🙏 😊).

COMPORTAMENTO:
- Sempre ACUSE RECEBIMENTO do que o cliente pediu ou disse. "Entendi!", "Anotado!", "Ótima escolha!", "Perfeito!".
- Se o cliente fez um pedido, confirme os itens com entusiasmo antes de perguntar o próximo passo.
- Faça sugestões naturais quando fizer sentido ("Quer algo para acompanhar?", "A carne de sol combina bem com...").
- Em caso de dúvida ou pedido não entendido, peça gentilmente para repetir, sem soar robótico.
- NUNCA invente preços, pratos ou informações que não forem passadas nos dados.
- SEMPRE inclua as informações obrigatórias dos "dados" (cardápio, resumo, total, etc.) quando indicado.
- Use *negrito* para destacar valores ou títulos importantes.
- Nunca diga que é "assistente", "IA" ou "bot". Você é o atendente do restaurante.`;

/**
 * Gera uma resposta humanizada do agente.
 * @param {Object} opts
 * @param {string} opts.etapa - Etapa atual do fluxo (ex: saudacao, cardapio_pratos, resumo_pedido)
 * @param {string} opts.mensagemCliente - Última mensagem do cliente
 * @param {string} [opts.contexto] - Texto extra para a IA (ex: "Cliente acabou de ver o cardápio")
 * @param {Object} [opts.dados] - Dados estruturados: listaPratos, listaBebidas, itensAdicionados, resumoPedido, total, formaPagamento, comanda, pedidoAtual
 * @returns {Promise<string>} Mensagem para enviar ao cliente
 */
async function gerarRespostaAgente({ etapa, mensagemCliente, contexto = '', dados = {} }) {
  if (!process.env.GEMINI_API_KEY) {
    return null;
  }

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: INSTRUCOES_SISTEMA,
  });

  const partes = [
    `Etapa atual: ${etapa}.`,
    contexto ? `Contexto: ${contexto}` : '',
    `Mensagem do cliente: "${mensagemCliente}"`,
  ];

  if (Object.keys(dados).length > 0) {
    partes.push('\nDados que você DEVE usar (inclua quando fizer sentido):');
    if (dados.pedidoAtual) partes.push(`O que o cliente já pediu até agora: ${dados.pedidoAtual}`);
    if (dados.listaPratos) partes.push(`Cardápio pratos:\n${dados.listaPratos}`);
    if (dados.listaBebidas) partes.push(`Cardápio bebidas:\n${dados.listaBebidas}`);
    if (dados.itensAdicionados) partes.push(`Itens que ACABARAM de ser adicionados: ${dados.itensAdicionados} — reconheça isso na sua resposta.`);
    if (dados.resumoPedido) partes.push(`Resumo do pedido:\n${dados.resumoPedido}`);
    if (dados.total != null) partes.push(`Total: R$ ${Number(dados.total).toFixed(2)}`);
    if (dados.formaPagamento) partes.push(`Forma de pagamento: ${dados.formaPagamento}`);
    if (dados.comanda) partes.push(`Texto da comanda (enviar em seguida):\n${dados.comanda}`);
    if (dados.opcoesPagamento) partes.push(`Opções de pagamento: ${dados.opcoesPagamento}`);
  }

  partes.push('\nGere APENAS a mensagem que você enviaria ao cliente. Natural, calorosa, como um atendente real. Sem prefixos tipo "Como atendente..." — só a mensagem.');

  const prompt = partes.filter(Boolean).join('\n');

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    if (!response || !response.text) return null;
    return response.text().trim();
  } catch (err) {
    console.error('[Agente IA] Erro ao gerar resposta:', err.message);
    return null;
  }
}

/**
 * Detecta a intenção do cliente a partir da mensagem e da etapa atual.
 * Usa a IA para entender frases naturais ("pode me mostrar o cardápio de novo", "não quero mais", etc.).
 * @param {string} etapa - Etapa atual: aguardando_cardapio, escolhendo_pratos, escolhendo_bebidas, confirmando_pedido, pagamento
 * @param {string} mensagemCliente - Mensagem do cliente
 * @returns {Promise<string>} Uma das intenções: QUER_VER_CARDAPIO, VER_CARDAPIO, CANCELAR, PRONTO, ESCOLHER_ITENS, NAO_QUERO_BEBIDA, CONFIRMAR_SIM, CONFIRMAR_NAO, PAGAMENTO_PIX, PAGAMENTO_DINHEIRO, PAGAMENTO_CARTAO, DESCONHECIDO
 */
async function detectarIntent(etapa, mensagemCliente) {
  if (!process.env.GEMINI_API_KEY || !mensagemCliente || !mensagemCliente.trim()) {
    return 'DESCONHECIDO';
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `Você é um classificador de intenção para um bot de restaurante no WhatsApp.

Etapa atual da conversa: ${etapa}
Mensagem do cliente: "${mensagemCliente.trim()}"

Intenções possíveis (responda APENAS com uma dessas palavras, nada mais):
- QUER_VER_CARDAPIO: cliente quer ver o cardápio ou está engajando (ex: "sim", "quero", "pode", "e aí", "fala", "opa", "mostra o cardápio", "me manda")
- VER_CARDAPIO: cliente pede para ver o cardápio novamente (ex: "mostra de novo", "pode mostrar o cardápio novamente", "ver o cardápio de novo")
- CANCELAR: cliente quer desistir, encerrar, não quer mais (ex: "não quero mais", "obrigado até a próxima", "cancelar", "deixa pra lá", "sair")
- PRONTO: cliente terminou de escolher (ex: "pronto", "é isso", "só isso", "pode ser")
- ESCOLHER_ITENS: cliente está fazendo pedido — números (ex: "1 2") ou linguagem natural (ex: "quero 1 maminha e 2 carne de sol")
- NAO_QUERO_BEBIDA: não quer bebida (ex: "não", "não quero", "obrigado não")
- CONFIRMAR_SIM: confirma que o pedido está certo (ex: "sim", "está certo", "confirmo")
- CONFIRMAR_NAO: não confirma o pedido (ex: "não", "errado")
- PAGAMENTO_PIX: quer pagar com Pix (ex: "pix", "1")
- PAGAMENTO_DINHEIRO: quer pagar em dinheiro (ex: "dinheiro", "2")
- PAGAMENTO_CARTAO: quer pagar com cartão (ex: "cartão", "3")
- DESCONHECIDO: não se encaixa nas acima

Responda com UMA ÚNICA PALAVRA da lista.`;

  try {
    const result = await model.generateContent(prompt);
    const text = (result.response && result.response.text() || '').trim().toUpperCase();
    const validas = ['QUER_VER_CARDAPIO', 'VER_CARDAPIO', 'CANCELAR', 'PRONTO', 'ESCOLHER_ITENS', 'NAO_QUERO_BEBIDA', 'CONFIRMAR_SIM', 'CONFIRMAR_NAO', 'PAGAMENTO_PIX', 'PAGAMENTO_DINHEIRO', 'PAGAMENTO_CARTAO', 'DESCONHECIDO'];
    const encontrada = validas.find(v => text.includes(v));
    return encontrada || 'DESCONHECIDO';
  } catch (err) {
    console.error('[Agente IA] Erro ao detectar intenção:', err.message);
    return 'DESCONHECIDO';
  }
}

/**
 * Interpreta pedido em linguagem natural e retorna lista de itens com quantidade.
 * Ex: "quero um de Maminha e dois de carne de sol" → [{ id: 1, quantidade: 1 }, { id: 2, quantidade: 2 }]
 * @param {string} mensagemCliente - Mensagem do cliente (ex: "quero 2 maminha e 1 linguiça")
 * @param {Array<{id: number, nome: string}>} listaItens - Cardápio (pratos ou bebidas) com id e nome
 * @returns {Promise<Array<{id: number, quantidade: number}>>} Lista de itens com quantidade, ou [] se não interpretar
 */
async function interpretarPedidoNatural(mensagemCliente, listaItens) {
  if (!process.env.GEMINI_API_KEY || !mensagemCliente?.trim() || !listaItens?.length) {
    return [];
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const cardapioStr = listaItens.map(i => `${i.id}: ${i.nome}`).join(', ');

  const prompt = `Você interpreta pedidos de restaurante. REGRAS CRÍTICAS:

1. "N quentinha(s) de [prato]" ou "N de [prato]" → N é QUANTIDADE, não ID. "3 quentinhas de maminha" = 3x Maminha.
2. Associe pelo NOME do prato. "maminha"→Maminha, "costela suina"→Costela suína. Ignore typos (suina=suína).
3. "quentinha/quentinhas/porção" = indicam porção, não mudam o item.

Cardápio (id: nome): ${cardapioStr}

Mensagem: "${mensagemCliente.trim()}"

Exemplos:
- "3 quentinha de maminha e 2 quentinhas de costela suina" → [{"id":1,"quantidade":3},{"id":7,"quantidade":2}]
- "2 maminha e 1 linguiça" → [{"id":1,"quantidade":2},{"id":5,"quantidade":1}]
- "quero um de Maminha e dois de carne de sol" → [{"id":1,"quantidade":1},{"id":2,"quantidade":2}]
- "quero o 1 e o 3" (só números) → [{"id":1,"quantidade":1},{"id":3,"quantidade":1}]
- "só quero falar" → []

Responda APENAS JSON: [{"id":n,"quantidade":n},...]. Se não for pedido, [].`;

  try {
    const result = await model.generateContent(prompt);
    const text = (result.response && result.response.text() || '').trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const idsValidos = new Set(listaItens.map(i => i.id));
    return parsed
      .filter(p => p && (typeof p.id === 'number' || typeof p.id === 'string') && (typeof p.quantidade === 'number' || typeof p.quantidade === 'string') && Number(p.quantidade) > 0 && idsValidos.has(Number(p.id)))
      .map(p => ({ id: Number(p.id), quantidade: Math.min(99, Math.floor(Number(p.quantidade))) }));
  } catch (err) {
    console.error('[Agente IA] Erro ao interpretar pedido:', err.message);
    return [];
  }
}

module.exports = { gerarRespostaAgente, detectarIntent, interpretarPedidoNatural };
