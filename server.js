require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { twiml: { MessagingResponse } } = require('twilio');
const { gerarRespostaAgente, detectarIntent, interpretarPedidoNatural } = require('./agente');

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'keyboard-cat',
  resave: false,
  saveUninitialized: false,
}));

app.set('view engine', 'ejs');

app.get('/', (req, res) => {
  res.redirect('/admin');
});

// ============================
// 🤖 WHATSAPP BOT - FLUXO CONVERSA
// ============================

// Extrai números da mensagem (ex: "1 2 3", "1 e 2", "quero o 1")
function extrairNumeros(texto) {
  return (texto.replace(/\s+e\s+/g, ' ').match(/\d+/g) || []).map(Number);
}

// Extrai itens com quantidade a partir de números (ex: "1 2 2" → [{id:1,qtd:1}, {id:2,qtd:2}])
function extrairItensComQuantidade(texto) {
  const nums = extrairNumeros(texto);
  const contagem = {};
  for (const n of nums) {
    contagem[n] = (contagem[n] || 0) + 1;
  }
  return Object.entries(contagem).map(([id, qtd]) => ({ id: Number(id), quantidade: qtd }));
}

// Verifica se a mensagem é "sim" / "quero ver" / "claro" etc.
function querVerCardapio(msg) {
  const sim = /\b(sim|claro|quero|pode|mostra|mostrar|ver|manda|mandar|envia|enviar)\b/i;
  return sim.test(msg) && !/\b(n[aã]o|nao)\b/i.test(msg);
}

// Verifica se o cliente terminou de escolher pratos
function terminouPratos(msg) {
  return /\b(pronto|é isso|e isso|quero esses|só isso|só isso|finalizar|acabei)\b/i.test(msg) && !extrairNumeros(msg).length;
}

// Verifica se não quer bebida
function naoQuerBebida(msg) {
  return /\b(n[aã]o|nao|obrigad[oa]\s*(mas\s*)?n[aã]o|nada|dispenso|não quero)\b/i.test(msg);
}

// Verifica se confirmou o pedido
function confirmouPedido(msg) {
  return /\b(sim|est[aá] certo|correto|confirmo|pode ser)\b/i.test(msg) && !/\b(n[aã]o|nao)\b/i.test(msg);
}

// Verifica se quer cancelar / encerrar sem pedir (regras locais para evitar loop)
function querCancelarOuSair(msg) {
  const t = msg.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /nao\s*quero|obrigad[oa].*ate|obrigad[oa].*proxima|ate\s*a\s*proxima|cancelar|sair|deixa\s*pra\s*la|desistir|parar|tchau|ate\s*mais/.test(t) ||
    (t.includes('obrigado') && (t.includes('ate') || t.includes('proxima')));
}

// Verifica se pediu para ver o cardápio de novo (regras locais para evitar loop)
function querVerCardapioDeNovo(msg) {
  const t = msg.toLowerCase().normalize('NFD').replace(/\u0300/g, '');
  if (!t.includes('cardapio')) return false;
  return /ver|mostrar|mostra|mostar|manda|mandar|envia|enviar|novamente|de\s*novo|denovo/i.test(t);
}

// Envia resposta: tenta o agente de IA primeiro, senão usa o texto fixo
async function responder(twiml, opts, fallback) {
  const texto = await gerarRespostaAgente(opts);
  twiml.message(texto || fallback);
}

// Rota GET para testar se a URL do webhook está acessível (abrir no navegador ou Twilio)
app.get('/whatsapp', (req, res) => {
  res.type('text/plain').send('Webhook WhatsApp OK. Use POST para mensagens.');
});

app.post('/whatsapp', async (req, res) => {
  const mensagem = (req.body.Body || '').trim();
  const telefone = (req.body.From || '').replace('whatsapp:', '');
  console.log('[WhatsApp] Mensagem recebida de', telefone, ':', mensagem || '(vazia)');

  const twiml = new MessagingResponse();
  const mensagemLower = mensagem.toLowerCase();

  try {

    let cliente = await pool.query(
      'SELECT * FROM clientes WHERE telefone=$1',
      [telefone]
    );

    if (cliente.rows.length === 0) {
      cliente = await pool.query(
        'INSERT INTO clientes (telefone, etapa) VALUES ($1, $2) RETURNING *',
        [telefone, 'inicio']
      );
    }

    const clienteData = cliente.rows[0];

    // ---------- INÍCIO: qualquer mensagem → oferta do cardápio ----------
    if (clienteData.etapa === 'inicio') {
      await responder(twiml, {
        etapa: 'saudacao_inicial',
        mensagemCliente: mensagem,
        contexto: 'Cliente mandou a primeira mensagem (oi, boa noite, etc). Cumprimente como atendente real, de forma calorosa, e ofereça o cardápio naturalmente.',
      }, "Boa noite! 👋 Tudo bem?\n\nGostaria de ver nosso cardápio para hoje? É só responder *sim* ou *claro*.");
      await pool.query(
        'UPDATE clientes SET etapa=$1 WHERE id=$2',
        ['aguardando_cardapio', clienteData.id]
      );
    }

    // ---------- Cliente pediu para ver cardápio → mostrar PRATOS ----------
    else if (clienteData.etapa === 'aguardando_cardapio') {
      const querVer = querVerCardapio(mensagemLower) || (await detectarIntent('aguardando_cardapio', mensagem)) === 'QUER_VER_CARDAPIO';
      if (!querVer) {
        await responder(twiml, {
          etapa: 'aguardando_querer_cardapio',
          mensagemCliente: mensagem,
          contexto: 'Cliente pode ter cumprimentado (oi, tudo bem), feito pergunta ou dado outra resposta. Responda de forma natural e calorosa, como um atendente real, e convide a ver o cardápio.',
        }, "Oi! Tudo certo por aí? 😊\n\nQuando quiser ver o cardápio, é só dizer *sim* ou *claro*!");
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const pratos = await pool.query(
        "SELECT id, nome, preco FROM cardapio WHERE ativo=true AND (categoria='prato' OR categoria IS NULL) ORDER BY id"
      );
      const listaPratos = pratos.rows.map(p =>
        `${p.id} - ${p.nome} - R$ ${Number(p.preco).toFixed(2)}`
      ).join('\n');

      await responder(twiml, {
        etapa: 'mostrando_cardapio_pratos',
        mensagemCliente: mensagem,
        contexto: 'Cliente pediu o cardápio. Mostre a lista de pratos e explique que ele pode digitar os números desejados (ex: 1 2) e *pronto* quando terminar.',
        dados: { listaPratos },
      }, `🍽️ *CARDÁPIO - PRATOS*\n\n${listaPratos}\n\nDigite os números (ex: 1 2) ou peça em texto (ex: *quero 1 maminha e 2 carne de sol*). Quando terminar, digite *pronto*.`);
      await pool.query(
        'UPDATE clientes SET etapa=$1 WHERE id=$2',
        ['escolhendo_pratos', clienteData.id]
      );
    }

    // ---------- Escolhendo PRATOS (pode mandar vários números, "pronto", cancelar ou ver cardápio de novo) ----------
    else if (clienteData.etapa === 'escolhendo_pratos') {

      // 1) Cancelar: regras locais primeiro (evita loop quando a API falha ou demora)
      if (querCancelarOuSair(mensagemLower)) {
        await responder(twiml, {
          etapa: 'cliente_desistiu',
          mensagemCliente: mensagem,
          contexto: 'Cliente desistiu ou quis encerrar. Despeça-se de forma calorosa e humana, como um atendente real. Diga que estará à disposição quando quiser.',
        }, "Tudo bem! Sem problemas. 😊 Quando quiser, é só mandar um *oi* que a gente atende. Até a próxima! 👋");
        await pool.query('UPDATE clientes SET etapa=$1 WHERE id=$2', ['inicio', clienteData.id]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      // 2) Ver cardápio de novo: regras locais primeiro (evita loop)
      if (querVerCardapioDeNovo(mensagemLower)) {
        const pratos = await pool.query(
          "SELECT id, nome, preco FROM cardapio WHERE ativo=true AND (categoria='prato' OR categoria IS NULL) ORDER BY id"
        );
        const listaPratos = pratos.rows.map(p =>
          `${p.id} - ${p.nome} - R$ ${Number(p.preco).toFixed(2)}`
        ).join('\n');
        twiml.message(`🍽️ *CARDÁPIO - PRATOS*\n\n${listaPratos}\n\nDigite os números (ex: 1 2) ou peça em texto (ex: *quero 1 maminha e 2 carne de sol*). Quando terminar, digite *pronto*.`);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const intentPratos = await detectarIntent('escolhendo_pratos', mensagem);
      if (intentPratos === 'CANCELAR') {
        await responder(twiml, {
          etapa: 'cliente_desistiu',
          mensagemCliente: mensagem,
          contexto: 'Cliente desistiu do pedido. Despeça-se.',
        }, "Tudo bem! Quando quiser, é só mandar *oi*. Até a próxima! 👋");
        await pool.query('UPDATE clientes SET etapa=$1 WHERE id=$2', ['inicio', clienteData.id]);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }
      if (intentPratos === 'VER_CARDAPIO') {
        const pratos = await pool.query(
          "SELECT id, nome, preco FROM cardapio WHERE ativo=true AND (categoria='prato' OR categoria IS NULL) ORDER BY id"
        );
        const listaPratos = pratos.rows.map(p =>
          `${p.id} - ${p.nome} - R$ ${Number(p.preco).toFixed(2)}`
        ).join('\n');
        twiml.message(`🍽️ *CARDÁPIO - PRATOS*\n\n${listaPratos}\n\nDigite os números (ex: 1 2) ou peça em texto (ex: *quero 1 maminha e 2 carne de sol*). Quando terminar, digite *pronto*.`);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (terminouPratos(mensagemLower) || intentPratos === 'PRONTO') {
        const pedidoAtual = await pool.query(
          `SELECT id FROM pedidos WHERE cliente_id=$1 AND status='montando' ORDER BY criado_em DESC LIMIT 1`,
          [clienteData.id]
        );
        if (pedidoAtual.rows.length === 0) {
          await responder(twiml, {
            etapa: 'lembrete_escolher_pratos',
            mensagemCliente: mensagem,
            contexto: 'Cliente disse pronto mas ainda não escolheu prato. De forma gentil e sem soar cobrando, peça para escolher os itens.',
          }, "Calma, ainda não anotei nada! 😅 Escolha os pratos — pode digitar os números (ex: 1 2) ou escrever *quero 1 maminha e 2 carne de sol*. Quando terminar, aí sim *pronto*.");
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }

        const bebidas = await pool.query(
          "SELECT id, nome, preco FROM cardapio WHERE ativo=true AND categoria='bebida' ORDER BY id"
        );
        const listaBebidas = bebidas.rows.length
          ? bebidas.rows.map(b => `${b.id} - ${b.nome} - R$ ${Number(b.preco).toFixed(2)}`).join('\n')
          : 'Nenhuma bebida no momento.';

        await responder(twiml, {
          etapa: 'oferta_bebidas_e_cardapio_bebidas',
          mensagemCliente: mensagem,
          contexto: 'Cliente finalizou os pratos. Reconheça e ofereça bebidas com entusiasmo. Mostre o cardápio e diga que pode digitar números ou *não*.',
          dados: { listaBebidas },
        }, `Pratos anotados! 👍\n\nGostaria de algo para beber? 🥤\n\n*CARDÁPIO - BEBIDAS*\n\n${listaBebidas}\n\nDigite os números ou *não* se não quiser.`);
        await pool.query(
          'UPDATE clientes SET etapa=$1 WHERE id=$2',
          ['escolhendo_bebidas', clienteData.id]
        );
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      let itensPedido = extrairItensComQuantidade(mensagemLower);
      if (itensPedido.length === 0) {
        const pratosCardapio = await pool.query(
          "SELECT id, nome FROM cardapio WHERE ativo=true AND (categoria='prato' OR categoria IS NULL) ORDER BY id"
        );
        itensPedido = await interpretarPedidoNatural(mensagem, pratosCardapio.rows);
      }
      if (itensPedido.length === 0) {
        await responder(twiml, {
          etapa: 'escolhendo_pratos_sem_pedido_claro',
          mensagemCliente: mensagem,
          contexto: 'A mensagem pode ser: pergunta (ex: quanto demora?, tem entrega?), comentário, ou pedido que não entendemos. Responda como atendente real: se for pergunta, ajude; se for confusão, peça gentilmente para repetir. Depois oriente: pode digitar números ou falar em texto (ex: quero 1 maminha e 2 carne de sol). Seja natural, não robótico.',
        }, "Não consegui entender direito. 😅 Pode digitar os números (ex: 1 2) ou escrever tipo *quero 1 maminha e 2 carne de sol*? Quando terminar, *pronto*.");
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const idsUnicos = [...new Set(itensPedido.map(i => i.id))];
      const pratos = await pool.query(
        "SELECT id, nome, preco FROM cardapio WHERE ativo=true AND id = ANY($1) AND (categoria='prato' OR categoria IS NULL)",
        [idsUnicos]
      );
      const mapaPratos = Object.fromEntries(pratos.rows.map(p => [p.id, p]));
      const itensValidos = itensPedido.filter(i => mapaPratos[i.id]);

      let pedido = await pool.query(
        `SELECT id FROM pedidos WHERE cliente_id=$1 AND status='montando' ORDER BY criado_em DESC LIMIT 1`,
        [clienteData.id]
      );

      if (pedido.rows.length === 0) {
        pedido = await pool.query(
          'INSERT INTO pedidos (cliente_id, status) VALUES ($1,$2) RETURNING id',
          [clienteData.id, 'montando']
        );
      }

      const pedidoId = pedido.rows[0].id;
      const nomesArr = [];
      for (const item of itensValidos) {
        const p = mapaPratos[item.id];
        await pool.query(
          'INSERT INTO itens_pedido (pedido_id, nome_item, preco, quantidade) VALUES ($1,$2,$3,$4)',
          [pedidoId, p.nome, p.preco, item.quantidade]
        );
        nomesArr.push(item.quantidade > 1 ? `${p.nome} x${item.quantidade}` : p.nome);
      }
      const nomes = nomesArr.join(', ');

      await pool.query(`
        UPDATE pedidos SET total = (
          SELECT COALESCE(SUM(preco * quantidade), 0) FROM itens_pedido WHERE pedido_id = $1
        ) WHERE id = $1
      `, [pedidoId]);
      const itensPedidoAtual = await pool.query('SELECT nome_item, quantidade FROM itens_pedido WHERE pedido_id=$1', [pedidoId]);
      const pedidoAtualStr = itensPedidoAtual.rows.map(i => `${i.nome_item} x${i.quantidade}`).join(', ');
      await responder(twiml, {
        etapa: 'pratos_adicionados',
        mensagemCliente: mensagem,
        contexto: 'Cliente acabou de pedir pratos. Reconheça o pedido com entusiasmo, confirme os itens adicionados e pergunte se quer mais algum ou pronto para bebidas.',
        dados: { itensAdicionados: nomes, pedidoAtual: pedidoAtualStr },
      }, `Anotado! ${nomes}. 👍\n\nQuer mais algum prato? Digite os números ou *pronto* para ir para as bebidas.`);
    }

    // ---------- Escolhendo BEBIDAS ou "não quero" / "pronto" / ver cardápio de novo ----------
    else if (clienteData.etapa === 'escolhendo_bebidas') {

      const intentBebidas = await detectarIntent('escolhendo_bebidas', mensagem);
      const querConfirmar = naoQuerBebida(mensagemLower) || terminouPratos(mensagemLower) || intentBebidas === 'NAO_QUERO_BEBIDA';

      if (intentBebidas === 'VER_CARDAPIO') {
        const bebidas = await pool.query(
          "SELECT id, nome, preco FROM cardapio WHERE ativo=true AND categoria='bebida' ORDER BY id"
        );
        const listaBebidas = bebidas.rows.length
          ? bebidas.rows.map(b => `${b.id} - ${b.nome} - R$ ${Number(b.preco).toFixed(2)}`).join('\n')
          : 'Nenhuma bebida no momento.';
        await responder(twiml, {
          etapa: 'mostrando_cardapio_bebidas',
          mensagemCliente: mensagem,
          contexto: 'Cliente pediu para ver o cardápio de bebidas de novo.',
          dados: { listaBebidas },
        }, `🥤 *CARDÁPIO - BEBIDAS*\n\n${listaBebidas}\n\nDigite os números das bebidas ou *não* se não quiser.`);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      if (querConfirmar) {
        const pedido = await pool.query(
          `SELECT id FROM pedidos WHERE cliente_id=$1 AND status='montando' ORDER BY criado_em DESC LIMIT 1`,
          [clienteData.id]
        );
        if (pedido.rows.length === 0) {
          await responder(twiml, {
            etapa: 'erro_pedido_nao_encontrado',
            mensagemCliente: mensagem,
            contexto: 'Pedido não encontrado. Peça ao cliente para começar de novo dizendo oi.',
          }, "Pedido não encontrado. Comece de novo dizendo *oi*.");
          await pool.query('UPDATE clientes SET etapa=$1 WHERE id=$2', ['inicio', clienteData.id]);
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          return res.end(twiml.toString());
        }

        const itens = await pool.query(
          'SELECT nome_item, preco, quantidade FROM itens_pedido WHERE pedido_id=$1',
          [pedido.rows[0].id]
        );
        let total = 0;
        const linhas = itens.rows.map(i => {
          const sub = Number(i.preco) * Number(i.quantidade);
          total += sub;
          return `  • ${i.nome_item} x${i.quantidade} - R$ ${sub.toFixed(2)}`;
        }).join('\n');

        await responder(twiml, {
          etapa: 'resumo_pedido_pedir_confirmacao',
          mensagemCliente: mensagem,
          contexto: 'Cliente não quis bebida ou confirmou. Mostre o resumo com carinho e pergunte se está tudo certo. Seja natural.',
          dados: { resumoPedido: linhas, total },
        }, `Beleza! 👍 Vamos confirmar:\n\n📋 *SEU PEDIDO*\n${linhas}\n\n*Total: R$ ${total.toFixed(2)}*\n\nEstá certo? Responda *sim* ou *não*`);
        await pool.query(
          'UPDATE pedidos SET status=$1 WHERE id=$2',
          ['confirmando', pedido.rows[0].id]
        );
        await pool.query(
          'UPDATE clientes SET etapa=$1 WHERE id=$2',
          ['confirmando_pedido', clienteData.id]
        );
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      let itensBebida = extrairItensComQuantidade(mensagemLower);
      if (itensBebida.length === 0) {
        const bebidasCardapio = await pool.query(
          "SELECT id, nome FROM cardapio WHERE ativo=true AND categoria='bebida' ORDER BY id"
        );
        itensBebida = await interpretarPedidoNatural(mensagem, bebidasCardapio.rows);
      }
      if (itensBebida.length === 0) {
        await responder(twiml, {
          etapa: 'escolhendo_bebidas_sem_pedido_claro',
          mensagemCliente: mensagem,
          contexto: 'A mensagem pode ser pergunta, comentário ou pedido não entendido. Responda como atendente humano. Depois oriente: números ou nome das bebidas, ou *não* se não quiser.',
        }, "Não consegui entender. 😅 Digite os números (ex: 9 10) ou o nome (ex: *quero 2 coca*). Se não quiser bebida, digite *não*.");
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const idsBebidas = [...new Set(itensBebida.map(i => i.id))];
      const bebidas = await pool.query(
        "SELECT id, nome, preco FROM cardapio WHERE ativo=true AND id = ANY($1) AND categoria='bebida'",
        [idsBebidas]
      );
      const mapaBebidas = Object.fromEntries(bebidas.rows.map(b => [b.id, b]));
      const itensBebidaValidos = itensBebida.filter(i => mapaBebidas[i.id]);

      const pedido = await pool.query(
        `SELECT id FROM pedidos WHERE cliente_id=$1 AND status='montando' ORDER BY criado_em DESC LIMIT 1`,
        [clienteData.id]
      );
      if (pedido.rows.length === 0) {
        await responder(twiml, {
          etapa: 'erro_pedido_nao_encontrado',
          mensagemCliente: mensagem,
        }, "Pedido não encontrado.");
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        return res.end(twiml.toString());
      }

      const nomesBebidasArr = [];
      for (const item of itensBebidaValidos) {
        const b = mapaBebidas[item.id];
        await pool.query(
          'INSERT INTO itens_pedido (pedido_id, nome_item, preco, quantidade) VALUES ($1,$2,$3,$4)',
          [pedido.rows[0].id, b.nome, b.preco, item.quantidade]
        );
        nomesBebidasArr.push(item.quantidade > 1 ? `${b.nome} x${item.quantidade}` : b.nome);
      }
      await pool.query(`
        UPDATE pedidos SET total = (
          SELECT COALESCE(SUM(preco * quantidade), 0) FROM itens_pedido WHERE pedido_id = $1
        ) WHERE id = $1
      `, [pedido.rows[0].id]);

      const nomes = nomesBebidasArr.join(', ');
      const itensPedidoAtualBeb = await pool.query('SELECT nome_item, quantidade FROM itens_pedido WHERE pedido_id=$1', [pedido.rows[0].id]);
      const pedidoAtualBebStr = itensPedidoAtualBeb.rows.map(i => `${i.nome_item} x${i.quantidade}`).join(', ');
      await responder(twiml, {
        etapa: 'bebidas_adicionadas',
        mensagemCliente: mensagem,
        contexto: 'Cliente acabou de pedir bebidas. Reconheça com naturalidade e pergunte se quer mais alguma ou não para confirmar.',
        dados: { itensAdicionados: nomes, pedidoAtual: pedidoAtualBebStr },
      }, `Anotado! ${nomes}.\n\nMais alguma bebida? Digite os números ou *não* para confirmar o pedido.`);
    }

    // ---------- Confirmando pedido (está certo?) ----------
    else if (clienteData.etapa === 'confirmando_pedido') {

      const intentConfirma = await detectarIntent('confirmando_pedido', mensagem);
      const confirmou = confirmouPedido(mensagemLower) || intentConfirma === 'CONFIRMAR_SIM';
      const naoConfirmou = intentConfirma === 'CONFIRMAR_NAO';

      if (confirmou) {
        await responder(twiml, {
          etapa: 'pedir_forma_pagamento',
          mensagemCliente: mensagem,
          contexto: 'Cliente confirmou o pedido. Pergunte a forma de pagamento e liste as opções.',
          dados: { opcoesPagamento: '1 - Pix, 2 - Dinheiro, 3 - Cartão' },
        }, "Qual será a forma de pagamento?\n\n*1* - Pix\n*2* - Dinheiro\n*3* - Cartão");
        await pool.query(
          'UPDATE clientes SET etapa=$1 WHERE id=$2',
          ['pagamento', clienteData.id]
        );
      } else if (naoConfirmou) {
        await responder(twiml, {
          etapa: 'pedido_cancelado',
          mensagemCliente: mensagem,
          contexto: 'Cliente não confirmou o pedido. Despeça-se com educação e diga que pode mandar oi para recomeçar.',
        }, "Pedido cancelado. Quando quiser, mande *oi* para começar de novo.");
        await pool.query(
          'UPDATE clientes SET etapa=$1 WHERE id=$2',
          ['inicio', clienteData.id]
        );
      } else {
        await responder(twiml, {
          etapa: 'confirmando_pedido_duvida',
          mensagemCliente: mensagem,
          contexto: 'Cliente não respondeu sim ou não. Pergunte novamente se o pedido está certo.',
        }, "O pedido está certo? Responda *sim* ou *não*.");
      }
    }

    // ---------- Pagamento → mensagem final + comanda ----------
    else if (clienteData.etapa === 'pagamento') {

      const intentPag = await detectarIntent('pagamento', mensagem);
      let forma = null;
      if (mensagemLower === '1' || /pix/i.test(mensagemLower) || intentPag === 'PAGAMENTO_PIX') forma = 'Pix';
      else if (mensagemLower === '2' || /dinheiro/i.test(mensagemLower) || intentPag === 'PAGAMENTO_DINHEIRO') forma = 'Dinheiro';
      else if (mensagemLower === '3' || /cart[aã]o/i.test(mensagemLower) || intentPag === 'PAGAMENTO_CARTAO') forma = 'Cartão';

      if (!forma) {
        twiml.message("Opção inválida. Escolha 1 (Pix), 2 (Dinheiro) ou 3 (Cartão).");
      } else {

        const pedido = await pool.query(
          `SELECT id FROM pedidos WHERE cliente_id=$1 AND status='confirmando' ORDER BY criado_em DESC LIMIT 1`,
          [clienteData.id]
        );
        const pedidoId = pedido.rows[0].id;

        await pool.query(
          'UPDATE pedidos SET forma_pagamento=$1, status=$2 WHERE id=$3',
          [forma, 'novo', pedidoId]
        );

        const itens = await pool.query(
          'SELECT nome_item, preco, quantidade FROM itens_pedido WHERE pedido_id=$1',
          [pedidoId]
        );
        let total = 0;
        const linhas = itens.rows.map(i => {
          const sub = Number(i.preco) * Number(i.quantidade);
          total += sub;
          return `  • ${i.nome_item} x${i.quantidade} - R$ ${sub.toFixed(2)}`;
        }).join('\n');

        const comanda = `📄 *COMANDA #${pedidoId}*\n${linhas}\n*Total: R$ ${total.toFixed(2)}*\nPagamento: ${forma}\nCliente: ${telefone}`;

        await responder(twiml, {
          etapa: 'encerramento_agradecimento',
          mensagemCliente: mensagem,
          contexto: 'Cliente escolheu a forma de pagamento. Agradeça a preferência, diga que o valor será cobrado na entrega e despeça-se até a próxima. Não inclua a comanda nesta mensagem (será enviada em seguida).',
          dados: { formaPagamento: forma },
        }, "Ficamos agradecidos pela sua preferência! 🙏\n\nO valor será cobrado na entrega. Até a próxima!");
        twiml.message(comanda);

        await pool.query(
          'UPDATE clientes SET etapa=$1 WHERE id=$2',
          ['inicio', clienteData.id]
        );
      }
    }

    else {
      await responder(twiml, {
        etapa: 'fora_do_fluxo',
        mensagemCliente: mensagem,
        contexto: 'Cliente mandou algo fora do fluxo. Responda como atendente acolhedor, sem soar robótico. Convide a fazer um pedido de forma natural.',
      }, "Oi! 👋 Em que posso ajudar? Mande *oi* ou *boa noite* para começar um pedido.");
    }

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());

  } catch (err) {
    console.error(err);
    try {
      await responder(twiml, {
        etapa: 'erro_interno',
        mensagemCliente: (req.body && req.body.Body) ? String(req.body.Body).trim() : '',
        contexto: 'Ocorreu um erro técnico. Peça desculpas e sugira tentar de novo ou mandar oi.',
      }, "Desculpe, ocorreu um erro. Tente de novo ou mande *oi* para recomeçar.");
    } catch (_) {
      twiml.message("Desculpe, ocorreu um erro. Tente de novo ou mande *oi* para recomeçar.");
    }
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }
});


// ============================
// 🔐 LOGIN ADMIN (bcrypt)
// ============================

app.get('/admin', (req, res) => {
  res.render('login', { error: null });
});

app.post('/admin/login', async (req, res) => {

  const { email, password } = req.body;

  if (!email || !password) {
    return res.render('login', { error: 'Preencha email e senha.' });
  }

  const admin = await pool.query(
    'SELECT * FROM admins WHERE email=$1',
    [email.trim()]
  );

  if (admin.rows.length === 0) {
    return res.render('login', { error: 'Usuário não encontrado.' });
  }

  const match = await bcrypt.compare(
    password,
    admin.rows[0].password_hash
  );

  if (!match) {
    return res.render('login', { error: 'Senha incorreta.' });
  }

  req.session.admin = admin.rows[0].id;
  res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => {});
  res.redirect('/admin');
});

function auth(req, res, next) {
  if (!req.session.admin) {
    return res.redirect('/admin');
  }
  next();
}


// ============================
// 📊 DASHBOARD
// ============================

app.get('/admin/dashboard', auth, async (req, res) => {

  const pedidos = await pool.query(`
    SELECT p.*, c.telefone
    FROM pedidos p
    LEFT JOIN clientes c ON p.cliente_id = c.id
    WHERE p.status != 'montando'
    ORDER BY p.criado_em DESC
    LIMIT 8
  `);

  const pedidosComItens = await Promise.all(
    pedidos.rows.map(async (p) => {
      const itens = await pool.query(
        'SELECT nome_item, preco, quantidade FROM itens_pedido WHERE pedido_id=$1',
        [p.id]
      );
      return { ...p, itens: itens.rows };
    })
  );

  const [totais] = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status != 'montando') as total,
      COALESCE(SUM(total) FILTER (WHERE status != 'montando'), 0) as faturamento,
      COUNT(*) FILTER (WHERE status IN ('novo', 'em_preparo')) as pendentes
    FROM pedidos
  `).then(r => r.rows);

  res.render('dashboard', {
    pedidos: pedidosComItens,
    totais: totais || { total: 0, faturamento: 0, pendentes: 0 },
  });
});

// Pedidos com filtros e paginação
const PER_PAGE = 10;
const STATUS_VALIDOS = ['novo', 'em_preparo', 'finalizado', 'entregue', 'confirmando', 'cancelado'];

app.get('/admin/pedidos', auth, async (req, res) => {

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const status = req.query.status;
  const dataInicio = req.query.dataInicio;
  const dataFim = req.query.dataFim;

  let where = ["p.status != 'montando'"];
  const params = [];
  let idx = 1;

  if (status && STATUS_VALIDOS.includes(status)) {
    where.push(`p.status = $${idx}`);
    params.push(status);
    idx++;
  }
  if (dataInicio) {
    where.push(`p.criado_em::date >= $${idx}`);
    params.push(dataInicio);
    idx++;
  }
  if (dataFim) {
    where.push(`p.criado_em::date <= $${idx}`);
    params.push(dataFim);
    idx++;
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const [countResult] = await pool.query(
    `SELECT COUNT(*) as total FROM pedidos p ${whereClause}`,
    params
  ).then(r => r.rows);

  const total = parseInt(countResult.total, 10);
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const offset = (page - 1) * PER_PAGE;

  const pedidos = await pool.query(`
    SELECT p.*, c.telefone
    FROM pedidos p
    LEFT JOIN clientes c ON p.cliente_id = c.id
    ${whereClause}
    ORDER BY p.criado_em DESC
    LIMIT ${PER_PAGE} OFFSET ${offset}
  `, params);

  const pedidosComItens = await Promise.all(
    pedidos.rows.map(async (p) => {
      const itens = await pool.query(
        'SELECT nome_item, preco, quantidade FROM itens_pedido WHERE pedido_id=$1',
        [p.id]
      );
      return { ...p, itens: itens.rows };
    })
  );

  const redirectQuery = [
    status && `status=${encodeURIComponent(status)}`,
    dataInicio && `dataInicio=${encodeURIComponent(dataInicio)}`,
    dataFim && `dataFim=${encodeURIComponent(dataFim)}`,
    `page=${page}`,
  ].filter(Boolean).join('&');

  res.render('pedidos', {
    pedidos: pedidosComItens,
    pagination: { page, totalPages, total, perPage: PER_PAGE },
    filters: { status: status || '', dataInicio: dataInicio || '', dataFim: dataFim || '' },
    redirectQuery,
  });
});


// ============================
// 🍔 CARDÁPIO
// ============================

app.get('/admin/cardapio', auth, async (req, res) => {

  const itens = await pool.query('SELECT * FROM cardapio ORDER BY id');
  const erro = req.query.erro === 'nome_duplicado' ? 'Já existe um item com esse nome. Use outro nome ou edite o existente.' : null;

  res.render('cardapio', { itens: itens.rows, erro });
});

app.post('/admin/cardapio/add', auth, async (req, res) => {

  const categoria = (req.body.categoria || 'prato').toLowerCase();
  const ativo = req.body.ativo === 'on' || req.body.ativo === 'true';
  const nome = (req.body.nome || '').trim();

  try {
    await pool.query(
      'INSERT INTO cardapio (nome, descricao, preco, categoria, ativo) VALUES ($1,$2,$3,$4,$5)',
      [nome, req.body.descricao?.trim() || null, parseFloat(req.body.preco) || 0, categoria, ativo]
    );
    res.redirect('/admin/cardapio');
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect('/admin/cardapio?erro=nome_duplicado');
    }
    throw err;
  }
});

app.get('/admin/cardapio/editar/:id', auth, async (req, res) => {
  const item = await pool.query('SELECT * FROM cardapio WHERE id=$1', [req.params.id]);
  if (item.rows.length === 0) return res.redirect('/admin/cardapio');
  res.render('cardapio-editar', { item: item.rows[0] });
});

app.post('/admin/cardapio/editar/:id', auth, async (req, res) => {

  const categoria = (req.body.categoria || 'prato').toLowerCase();
  const ativo = req.body.ativo === 'on' || req.body.ativo === 'true';

  await pool.query(
    'UPDATE cardapio SET nome=$1, descricao=$2, preco=$3, categoria=$4, ativo=$5 WHERE id=$6',
    [req.body.nome?.trim(), req.body.descricao?.trim() || null, parseFloat(req.body.preco) || 0, categoria, ativo, req.params.id]
  );

  res.redirect('/admin/cardapio');
});

app.post('/admin/cardapio/excluir/:id', auth, async (req, res) => {
  await pool.query('DELETE FROM cardapio WHERE id=$1', [req.params.id]);
  res.redirect('/admin/cardapio');
});

app.post('/admin/pedido/:id/status', auth, async (req, res) => {
  const status = req.body.status;
  const valid = ['novo', 'em_preparo', 'finalizado', 'entregue', 'cancelado'];
  if (valid.includes(status)) {
    await pool.query('UPDATE pedidos SET status=$1 WHERE id=$2', [status, req.params.id]);
  }
  const redirectTo = req.body.redirect === 'pedidos' ? '/admin/pedidos' : '/admin/dashboard';
  const qs = (req.body.redirectQuery || '').toString().trim();
  res.redirect(redirectTo + (qs ? '?' + qs : ''));
});

app.get('/admin/pedidos-count', async (req, res) => {
  const result = await pool.query('SELECT COUNT(*) FROM pedidos');
  res.json({ count: Number(result.rows[0].count) });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
