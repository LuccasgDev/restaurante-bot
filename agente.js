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
    // Check if it's a quota exceeded error
    if (err.message.includes('quota exceeded') || err.message.includes('429')) {
      return null; // Return null to let fallback handle it naturally
    }
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
- CANCELAR: cliente quer desistir, encerrar, cancelar (ex: "não quero mais", "quero encerrar", "encerrar", "excerrar", "cancelar", "deixa pra lá", "sair")
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
    // Check if it's a quota exceeded error
    if (err.message.includes('quota exceeded') || err.message.includes('429')) {
      // Fallback to basic intent detection without AI - Smart sentiment analysis
      const msg = mensagemCliente.toLowerCase().trim();
      
      // === SISTEMA DE RECONHECIMENTO DE SENTIMENTOS ===
      
      // Palavras POSITIVAS
      const positivas = ['sim', 'quero', 'pode', 'mostra', 'vamos', 'claro', 'com certeza', 'gostaria', 'aceito', 'top', 'legal', 'boa', 'perfeito', 'ótimo', 'beleza', 'blz', 'ok', 'tá bom', 'bora', 'partiu', 'combinado'];
      
      // Palavras NEGATIVAS  
      const negativas = ['não', 'nao', 'cancelar', 'encerrar', 'desistir', 'agora não', 'depois', 'prefiro não', 'melhor não', 'deixa pra lá', 'mudei de ideia'];
      
      // Verificar sentimento principal
      const temPositiva = positivas.some(p => msg.includes(p));
      const temNegativa = negativas.some(n => msg.includes(n));
      
      // Cancelamento
      if (temNegativa || msg.includes('cancel') || msg.includes('encerr') || msg.includes('sair')) return 'CANCELAR';
      
      // Engajamento positivo - quer ver cardápio
      if (temPositiva || msg.includes('oi') || msg.includes('ola') || msg.includes('bom dia') || msg.includes('boa tarde') || msg.includes('boa noite')) return 'QUER_VER_CARDAPIO';
      
      // Pedido direto de cardápio
      if (msg.includes('cardápio') || msg.includes('menu') || msg.includes('opções')) return 'VER_CARDAPIO';
      
      // Finalização de pedido
      if (msg.includes('pronto') || msg.includes('é isso') || msg.includes('só isso') || msg.includes('pode ser') || msg.includes('fechado')) return 'PRONTO';
      
      // Recusa de bebida
      if (msg.includes('não quero') || msg.includes('nao quero') || msg.includes('sem bebida') || msg.includes('só os pratos')) return 'NAO_QUERO_BEBIDA';
      
      // Confirmação
      if (msg.includes('confirm') || msg.includes('está certo') || msg.includes('correto')) return 'CONFIRMAR_SIM';
      
      // Pagamento
      if (msg.includes('pix') || msg === '1') return 'PAGAMENTO_PIX';
      if (msg.includes('dinheiro') || msg === '2') return 'PAGAMENTO_DINHEIRO';
      if (msg.includes('cartão') || msg.includes('cartao') || msg === '3') return 'PAGAMENTO_CARTAO';
      
      // Contém números - provavelmente fazendo pedido
      if (/\d/.test(msg)) return 'ESCOLHER_ITENS';
      
      return 'DESCONHECIDO';
    }
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
    // Check if it's a quota exceeded error
    if (err.message.includes('quota exceeded') || err.message.includes('429')) {
      // Fallback to basic number extraction
      const numbers = mensagemCliente.match(/\d+/g);
      if (numbers && numbers.length > 0) {
        return numbers.map(num => ({ id: parseInt(num), quantidade: 1 }));
      }
    }
    return [];
  }
}

/**
 * Agente 100% — processa a mensagem e decide a ação.
 * Recebe o contexto completo e retorna { mensagem, acao, dados, proximaEtapa }.
 * O servidor apenas executa o que o agente decidir.
 */
async function processarMensagemAgente({ telefone, mensagem, etapa, pedidoAtual, cardapioPratos, cardapioBebidas, dadosCliente }) {
  if (!process.env.GEMINI_API_KEY) {
    return { mensagem: 'Desculpe, o atendimento está temporariamente indisponível. Tente mais tarde.', acao: 'responder', dados: {}, proximaEtapa: etapa };
  }

  const pratosStr = cardapioPratos.map(p => `${p.id}: ${p.nome} - R$ ${Number(p.preco).toFixed(2)}`).join('\n');
  const bebidasStr = cardapioBebidas.length ? cardapioBebidas.map(b => `${b.id}: ${b.nome} - R$ ${Number(b.preco).toFixed(2)}`).join('\n') : 'Nenhuma bebida no cardápio.';
  const pedidoStr = pedidoAtual ? pedidoAtual.itens.map(i => `  • ${i.nome_item} x${i.quantidade} - R$ ${(Number(i.preco) * Number(i.quantidade)).toFixed(2)}`).join('\n') + `\nTotal: R$ ${pedidoAtual.total}` : 'Nenhum item no pedido.';

  // === CHAMADA DA IA ===
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: INSTRUCOES_SISTEMA,
  });

  const prompt = `Você é o atendente do restaurante. Decida o que fazer com base na mensagem do cliente e no contexto.

CONTEXTO:
- Etapa atual: ${etapa === 'start' ? 'inicio' : etapa}
- Pedido atual:\n${pedidoStr}
- Cardápio pratos:\n${pratosStr}
- Cardápio bebidas:\n${bebidasStr}

Mensagem do cliente: "${mensagem}"

FLUXO DO RESTAURANTE (você decide o próximo passo):
1. inicio/aguardando_cardapio → Cliente quer cardápio? → mostrar_cardapio_pratos
2. escolhendo_pratos → Cliente pediu pratos? → adicionar_pratos | Pronto/sem mais? → oferecer_bebidas | Cancelar? → cancelar
3. escolhendo_bebidas → Cliente pediu bebidas? → adicionar_bebidas | Não quero/confirmar? → mostrar_resumo_confirmar | Ver cardápio? → mostrar_cardapio_bebidas
4. confirmando_pedido → Confirmou? → pedir_pagamento | Não confirmou? → cancelar
5. pagamento → Escolheu forma (Pix/Dinheiro/Cartão)? → finalizar_pedido

REGRAS:
- "N quentinhas de [prato]" → N é QUANTIDADE (ex: 3 quentinhas de maminha = id 1, qtd 3)
- Associe pelo NOME do prato, ignore typos (costela suina = Costela suína)
- Para adicionar_pratos/adicionar_bebidas: extraia itens no formato [{id: número_do_cardápio, quantidade: número}]
- Cancelar: encerrar, excerrar, sair, não quero mais, etc.

Responda APENAS com um JSON válido (nada antes ou depois):
{"mensagem":"texto que você enviaria ao cliente","acao":"mostrar_cardapio_pratos|mostrar_cardapio_bebidas|adicionar_pratos|adicionar_bebidas|oferecer_bebidas|mostrar_resumo_confirmar|pedir_pagamento|finalizar_pedido|cancelar|responder","dados":{},"proximaEtapa":"inicio|aguardando_cardapio|escolhendo_pratos|escolhendo_bebidas|confirmando_pedido|pagamento"}

Para acao "adicionar_pratos" ou "adicionar_bebidas", inclua em dados: {"itens":[{"id":1,"quantidade":2},...]}
Para acao "finalizar_pedido", inclua em dados: {"formaPagamento":"Pix"|"Dinheiro"|"Cartão"}
Para outras ações, dados pode ser {}.`;

  try {
    const result = await model.generateContent(prompt);
    const text = (result.response && result.response.text() || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[Agente] Resposta não contém JSON:', text.slice(0, 200));
      return { mensagem: 'Desculpe, não consegui processar. Pode repetir?', acao: 'responder', dados: {}, proximaEtapa: etapa };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const acoesValidas = ['mostrar_cardapio_pratos', 'mostrar_cardapio_bebidas', 'adicionar_pratos', 'adicionar_bebidas', 'oferecer_bebidas', 'mostrar_resumo_confirmar', 'pedir_pagamento', 'finalizar_pedido', 'cancelar', 'responder'];
    return {
      mensagem: parsed.mensagem || 'Em que posso ajudar?',
      acao: acoesValidas.includes(parsed.acao) ? parsed.acao : 'responder',
      dados: parsed.dados || {},
      proximaEtapa: parsed.proximaEtapa || etapa,
    };
  } catch (err) {
    console.error('[Agente] Erro:', err.message);
    // Check if it's a quota exceeded error
    if (err.message.includes('quota exceeded') || err.message.includes('429')) {
      // Fallback to smart responses without AI - Agent-like behavior
      const msgLower = mensagem.toLowerCase().trim();
      const etapaAtual = etapa === 'start' ? 'inicio' : etapa;
      
      // === PROCESSAMENTO DE LINGUAGEM NATURAL (FORA DA IA) ===
      
      // Verificar se é um pedido em linguagem natural
      if (msgLower.includes('maminha') || msgLower.includes('carne de sol') || msgLower.includes('picanha') || msgLower.includes('frango') || msgLower.includes('linguiça') || msgLower.includes('costela') || msgLower.includes('ovo') || 
          cardapioPratos.some(p => msgLower.includes(p.nome.toLowerCase()))) {
        let itensEncontrados = [];
        
        // Extrair quantidades e pratos
        const texto = msgLower;
        
        // Criar padrões dinâmicos baseados no cardápio atual
        const padroes = [];
        
        // Adicionar padrões para cada prato do cardápio
        cardapioPratos.forEach(prato => {
          const nomeNormalizado = prato.nome.toLowerCase().replace(/\s+/g, '\\s*');
          
          // Padrão com "de" e opções de quantidade
          padroes.push(new RegExp(`(\\d+)\\s*(?:quentinha|quentinhas|porção|porções|unidade|unidades)?\\s*de\\s*${nomeNormalizado}`, 'gi'));
          
          // Padrão sem "de"
          padroes.push(new RegExp(`(\\d+)\\s*${nomeNormalizado}`, 'gi'));
        });
        
        // Processar cada padrão
        padroes.forEach(padrao => {
          let match;
          while ((match = padrao.exec(texto)) !== null) {
            const quantidade = parseInt(match[1]);
            const pratoTexto = match[0].toLowerCase();
            
            // Encontrar o prato correspondente no cardápio
            const pratoEncontrado = cardapioPratos.find(p => {
              const nomePrato = p.nome.toLowerCase();
              return pratoTexto.includes(nomePrato);
            });
            
            if (pratoEncontrado && quantidade > 0) {
              itensEncontrados.push({ id: pratoEncontrado.id, quantidade: Math.min(quantidade, 99) });
            }
          }
        });
        
        // Se não encontrou com padrões, busca simples baseada no cardápio
        if (itensEncontrados.length === 0) {
          cardapioPratos.forEach(prato => {
            const nomePrato = prato.nome.toLowerCase();
            if (msgLower.includes(nomePrato)) {
              itensEncontrados.push({ id: prato.id, quantidade: 1 });
            }
          });
        }
        
        // Se encontrou itens, monta resposta
        if (itensEncontrados.length > 0) {
          const nomesItens = itensEncontrados.map(item => {
            const prato = cardapioPratos.find(p => p.id === item.id);
            return `${item.quantidade}x ${prato.nome}`;
          }).join(', ');
          
          const comentarios = itensEncontrados.length > 1 ? 'Ótimas escolhas! ' : 'Ótima escolha! ';
          const comentarios2 = itensEncontrados.length > 1 ? 'Anotados: ' : 'Anotado: ';
          
          return { 
            mensagem: `✨ *Ótima escolha!* ${comentarios}${comentarios2}${nomesItens}. Mais alguma coisa? Quer adicionar alguma bebida para acompanhar? 🥤`, 
            acao: 'adicionar_pratos', 
            dados: { itens: itensEncontrados }, 
            proximaEtapa: 'escolhendo_pratos' 
          };
        }
      }
      
      // === SISTEMA DE RECONHECIMENTO DE SENTIMENTOS E INTENÇÕES ===
      
      // Palavras POSITIVAS - Aceitação, confirmação, interesse
      const positivas = [
        'sim', 'quero', 'pode', 'mostra', 'vamos', 'claro', 'com certeza', 'gostaria', 'pode ser',
        'aceito', 'top', 'legal', 'boa', 'perfeito', 'ótimo', 'maravilhoso', 'delícia',
        'anota', 'pode anotar', 'fechado', 'confirmado', 'beleza', 'blz', 'ok', 'tá bom',
        'vamos lá', 'bora', 'partiu', 'combinado', 'acertivo', 'decidido', 'escolhido'
      ];
      
      // Palavras NEGATIVAS - Recusa, cancelamento, dúvida
      const negativas = [
        'não', 'nao', 'cancelar', 'encerrar', 'desistir', 'agora não', 'depois',
        'prefiro não', 'melhor não', 'sem chance', 'deixa pra lá', 'esquece',
        'mudei de ideia', 'não quero', 'não gostei', 'não vale', 'cancelado'
      ];
      
      // Palavras de DÚVIDA/NEUTRALIDADE
      const neutras = [
        'talvez', 'acho que', 'será', 'vou ver', 'deixa eu pensar', 'não sei',
        'me diga', 'explique', 'como funciona', 'o que tem', 'quanto custa'
      ];
      
      // Verificar sentimento principal
      const temPositiva = positivas.some(p => msgLower.includes(p));
      const temNegativa = negativas.some(n => msgLower.includes(n));
      const temNeutra = neutras.some(n => msgLower.includes(n));
      
      // Welcome and engagement - Agent personality
      if (msgLower.includes('oi') || msgLower.includes('ola') || msgLower.includes('bom dia') || msgLower.includes('boa tarde') || msgLower.includes('boa noite')) {
        // Verificar se cliente já existe no banco
        const clienteExistente = dadosCliente && dadosCliente.nome;
        
        if (clienteExistente) {
          const nomeCliente = dadosCliente.nome;
          return { 
            mensagem: `Olá novamente, ${nomeCliente}! 👋 Que bom que você voltou! 😊 Posso ajudar com seu pedido de hoje ou quer ver nosso cardápio? 🍽️`, 
            acao: 'mostrar_cardapio_pratos', 
            dados: {}, 
            proximaEtapa: 'escolhendo_pratos' 
          };
        }
        
        return { 
          mensagem: 'Olá! 👋 Seja bem-vindo ao nosso restaurante! Sou seu atendente virtual e estou aqui para ajudar. Antes de continuar, qual é o seu nome?', 
          acao: 'solicitar_nome', 
          dados: {}, 
          proximaEtapa: 'coletando_nome' 
        };
      }
      
      // RESPOSTA POSITIVA - Mostrar cardápio com entusiasmo
      if (temPositiva && !temNegativa) {
        // Se está coletando nome, salvar e continuar
        if (etapa === 'coletando_nome') {
          return { 
            mensagem: `${entusiasmo}Prazer em conhecer, ${mensagem}! 👋 Agora vamos ao cardápio! 🍽️ *NOSSO CARDÁPIO - FIQUE A VONTADE!*\n\n${pratosStr}\n\n${bebidasStr}\n\n😋 Temos opções maravilhosas! Para fazer seu pedido, me diga os números (ex: "quero 1 e 3") ou descreva o que está com vontade! Posso anotar agora?`, 
            acao: 'salvar_nome_mostrar_cardapio', 
            dados: { nome: mensagem }, 
            proximaEtapa: 'escolhendo_pratos' 
          };
        }
        
        return { 
          mensagem: `${entusiasmo}🍽️ *NOSSO CARDÁPIO - FIQUE A VONTADE!*\n\n${pratosStr}\n\n${bebidasStr}\n\n😋 Temos opções maravilhosas! Para fazer seu pedido, me diga os números (ex: "quero 1 e 3") ou descreva o que está com vontade! Posso anotar agora?`, 
          acao: 'responder', 
          dados: {}, 
          proximaEtapa: etapaAtual 
        };
      }
      
      // RESPOSTA NEGATIVA - Cancelamento empático
      if (temNegativa || msgLower.includes('cancel') || msgLower.includes('encerr') || msgLower.includes('desistir')) {
        const empatico = msgLower.includes('mudei') ? 'Sem problemas! Mudanças acontecem 😊' :
                      msgLower.includes('agora não') ? 'Tudo bem! Sem problemas 😊' :
                      'Tudo bem! Sem problemas 😊';
        
        return { 
          mensagem: `${empatico} Se mudar de ideia, estarei aqui! Pode chamar quando quiser. Um ótimo dia! 👋`, 
          acao: 'cancelar', 
          dados: {}, 
          proximaEtapa: 'inicio' 
        };
      }
      
      // RESPOSTA NEUTRA/DÚVIDA - Ajuda informativa
      if (temNeutra || msgLower.includes('ajuda') || msgLower.includes('dúvida')) {
        return { 
          mensagem: `😊 *Claro! Estou aqui para ajudar!*\n\n${pratosStr}\n\n${bebidasStr}\n\n💡 *Dica:* Escolha pelo número (ex: "quero 1 e 2") ou me diga o nome do prato! Posso ajudar com mais alguma coisa?`, 
          acao: 'responder', 
          dados: {}, 
          proximaEtapa: etapaAtual 
        };
      }
      
      // Menu requests - Detailed and helpful
      if (msgLower.includes('cardápio') || msgLower.includes('menu') || msgLower.includes('opções') || msgLower.includes('o que tem')) {
        return { 
          mensagem: `🍽️ *NOSSO CARDÁPIO - DELÍCIAS ESPERANDO POR VOCÊ!*\n\n${pratosStr}\n\n${bebidasStr}\n\n💡 *Dica:* A Maminha e a Carne de sol são nossos campeões! A Picanta suína também é uma delícia. Me diga o que você gostaria de experimentar!`, 
          acao: 'responder', 
          dados: {}, 
          proximaEtapa: etapaAtual 
        };
      }
      
      // Try to extract numbers for ordering - Smart interpretation
      const numbers = mensagem.match(/\d+/g);
      if (numbers && numbers.length > 0 && cardapioPratos.length > 0) {
        const itens = numbers.map(num => {
          const id = parseInt(num);
          const item = cardapioPratos.find(p => p.id === id);
          return item ? { id, quantidade: 1 } : null;
        }).filter(Boolean);
        
        if (itens.length > 0) {
          const nomesItens = itens.map(i => cardapioPratos.find(p => p.id === i.id)?.nome).join(', ');
          const comentarios = nomesItens.includes('Maminha') ? ' Excelente escolha! ' : '';
          const comentarios2 = nomesItens.includes('Carne de sol') ? ' Nossa Carne de sol é imperdível! ' : '';
          
          return { 
            mensagem: `✨ *Ótima escolha!* ${comentarios}${comentarios2}Anotei: ${nomesItens}. Mais alguma coisa? Quer alguma bebida para acompanhar? 🥤`, 
            acao: 'adicionar_pratos', 
            dados: { itens }, 
            proximaEtapa: 'escolhendo_pratos' 
          };
        }
      }
      
      // Ready/confirmation - Natural
      if (msgLower.includes('pronto') || msgLower.includes('é isso') || msgLower.includes('só isso') || msgLower.includes('pode ser')) {
        // Se for entrega, solicitar endereço
        if (etapaAtual === 'escolhendo_pratos' || etapaAtual === 'escolhendo_bebidas') {
          return { 
            mensagem: '👍 *Perfeito!* Antes de finalizar, será entrega ou retirada? Se for entrega, por favor me informe seu endereço completo! 📍', 
            acao: 'solicitar_endereco_entrega', 
            dados: {}, 
            proximaEtapa: 'confirmando_entrega' 
          };
        }
        
        return { 
          mensagem: '👍 *Perfeito!* Vou preparar seu pedido! Quer adicionar alguma bebida ou podemos fechar por aqui? 🥤', 
          acao: 'oferecer_bebidas', 
          dados: {}, 
          proximaEtapa: 'escolhendo_bebidas' 
        };
      }
      
      // Don't want drinks - Natural
      if (msgLower.includes('não quero bebida') || msgLower.includes('nao quero bebida') || msgLower.includes('só os pratos') || msgLower.includes('sem bebida') || (msgLower.includes('não') && msgLower.includes('obrigado'))) {
        return { 
          mensagem: '👍 *Perfeito!* Vou preparar seu pedido então! Alguma observação especial? Alguma preferência no ponto da carne? 🍽️', 
          acao: 'finalizar_pedido', 
          dados: {}, 
          proximaEtapa: 'finalizando' 
        };
      }
      
      // Help/general - Agent personality
      return { 
        mensagem: '😊 *Sou seu atendente virtual!* Estou aqui para ajudar! Posso mostrar o cardápio, anotar seu pedido ou responder dúvidas. Me diga o que você gostaria? 🍽️', 
        acao: 'responder', 
        dados: {}, 
        proximaEtapa: etapaAtual 
      };
    }
    
    return { mensagem: 'Desculpe, ocorreu um erro. Tente novamente ou mande *oi*.', acao: 'responder', dados: {}, proximaEtapa: etapa };
  }
}

module.exports = { gerarRespostaAgente, detectarIntent, interpretarPedidoNatural, processarMensagemAgente };
