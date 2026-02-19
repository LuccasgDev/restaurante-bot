require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { twiml: { MessagingResponse } } = require('twilio');
const { processarMensagemAgente } = require('./agente');

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
// 🤖 AGENTE 100% — Orquestração por IA
// ============================

// Rota GET para testar se a URL do webhook está acessível (abrir no navegador ou Twilio)
app.get('/whatsapp', (req, res) => {
  res.type('text/plain').send('Webhook WhatsApp OK. Use POST para mensagens.');
});

app.post('/whatsapp', async (req, res) => {
  const mensagem = (req.body.Body || '').trim();
  const telefone = (req.body.From || '').replace('whatsapp:', '');
  console.log('[WhatsApp] Mensagem recebida de', telefone, ':', mensagem || '(vazia)');

  const twiml = new MessagingResponse();

  try {
    let cliente = await pool.query('SELECT * FROM clientes WHERE telefone=$1', [telefone]);
    if (cliente.rows.length === 0) {
      cliente = await pool.query('INSERT INTO clientes (telefone, etapa) VALUES ($1, $2) RETURNING *', [telefone, 'inicio']);
    }
    const clienteData = cliente.rows[0];
    const etapa = clienteData.etapa || 'inicio';

    // Carregar contexto para o agente
    const [pratosRes, bebidasRes, pedidoRes] = await Promise.all([
      pool.query("SELECT id, nome, preco FROM cardapio WHERE ativo=true AND (categoria='prato' OR categoria IS NULL) ORDER BY id"),
      pool.query("SELECT id, nome, preco FROM cardapio WHERE ativo=true AND categoria='bebida' ORDER BY id"),
      pool.query(`SELECT p.id, p.total,
        (SELECT json_agg(json_build_object('nome_item', i.nome_item, 'preco', i.preco, 'quantidade', i.quantidade))
         FROM itens_pedido i WHERE i.pedido_id = p.id) as itens
        FROM pedidos p WHERE p.cliente_id=$1 AND p.status IN ('montando','confirmando') ORDER BY p.criado_em DESC LIMIT 1`,
        [clienteData.id])
    ]);

    const cardapioPratos = pratosRes.rows;
    const cardapioBebidas = bebidasRes.rows;
    const pedidoRow = pedidoRes.rows[0];
    const pedidoAtual = pedidoRow ? {
      id: pedidoRow.id, total: Number(pedidoRow.total || 0).toFixed(2), itens: pedidoRow.itens || []
    } : null;

    const resultado = await processarMensagemAgente({
      telefone, mensagem, etapa, pedidoAtual, cardapioPratos, cardapioBebidas
    });

    const { mensagem: msgResposta, acao, dados, proximaEtapa } = resultado;

    // Executar ação decidida pelo agente
    if (acao === 'adicionar_pratos' && Array.isArray(dados.itens) && dados.itens.length > 0) {
      const mapaPratos = Object.fromEntries(cardapioPratos.map(p => [p.id, p]));
      let pedido = await pool.query(`SELECT id FROM pedidos WHERE cliente_id=$1 AND status='montando' ORDER BY criado_em DESC LIMIT 1`, [clienteData.id]);
      if (pedido.rows.length === 0) {
        pedido = await pool.query('INSERT INTO pedidos (cliente_id, status) VALUES ($1,$2) RETURNING id', [clienteData.id, 'montando']);
      }
      const pedidoId = pedido.rows[0].id;
      for (const item of dados.itens) {
        const p = mapaPratos[Number(item.id)];
        if (p && Number(item.quantidade) > 0) {
          await pool.query('INSERT INTO itens_pedido (pedido_id, nome_item, preco, quantidade) VALUES ($1,$2,$3,$4)', [pedidoId, p.nome, p.preco, Math.min(99, Number(item.quantidade))]);
        }
      }
      await pool.query(`UPDATE pedidos SET total = (SELECT COALESCE(SUM(preco * quantidade), 0) FROM itens_pedido WHERE pedido_id = $1) WHERE id = $1`, [pedidoId]);
    } else if (acao === 'adicionar_bebidas' && Array.isArray(dados.itens) && dados.itens.length > 0) {
      const mapaBebidas = Object.fromEntries(cardapioBebidas.map(b => [b.id, b]));
      const pedido = await pool.query(`SELECT id FROM pedidos WHERE cliente_id=$1 AND status='montando' ORDER BY criado_em DESC LIMIT 1`, [clienteData.id]);
      if (pedido.rows.length > 0) {
        for (const item of dados.itens) {
          const b = mapaBebidas[Number(item.id)];
          if (b && Number(item.quantidade) > 0) {
            await pool.query('INSERT INTO itens_pedido (pedido_id, nome_item, preco, quantidade) VALUES ($1,$2,$3,$4)', [pedido.rows[0].id, b.nome, b.preco, Math.min(99, Number(item.quantidade))]);
          }
        }
        await pool.query(`UPDATE pedidos SET total = (SELECT COALESCE(SUM(preco * quantidade), 0) FROM itens_pedido WHERE pedido_id = $1) WHERE id = $1`, [pedido.rows[0].id]);
      }
    } else if (acao === 'mostrar_resumo_confirmar') {
      await pool.query('UPDATE pedidos SET status=$1 WHERE id=$2', ['confirmando', pedidoAtual?.id]);
    } else if (acao === 'finalizar_pedido' && dados.formaPagamento) {
      const forma = ['Pix','Dinheiro','Cartão'].includes(dados.formaPagamento) ? dados.formaPagamento : 'Pix';
      const pedido = await pool.query(`SELECT id FROM pedidos WHERE cliente_id=$1 AND status='confirmando' ORDER BY criado_em DESC LIMIT 1`, [clienteData.id]);
      if (pedido.rows.length > 0) {
        await pool.query('UPDATE pedidos SET forma_pagamento=$1, status=$2 WHERE id=$3', [forma, 'novo', pedido.rows[0].id]);
        const itens = await pool.query('SELECT nome_item, preco, quantidade FROM itens_pedido WHERE pedido_id=$1', [pedido.rows[0].id]);
        let total = 0;
        const linhas = itens.rows.map(i => {
          const sub = Number(i.preco) * Number(i.quantidade);
          total += sub;
          return `  • ${i.nome_item} x${i.quantidade} - R$ ${sub.toFixed(2)}`;
        }).join('\n');
        const comanda = `📄 *COMANDA #${pedido.rows[0].id}*\n${linhas}\n*Total: R$ ${total.toFixed(2)}*\nPagamento: ${forma}\nCliente: ${telefone}`;
        twiml.message(msgResposta);
        twiml.message(comanda);
      } else {
        twiml.message(msgResposta);
      }
    } else {
      twiml.message(msgResposta);
    }

    // Atualizar etapa
    const novaEtapa = acao === 'cancelar' || acao === 'finalizar_pedido' ? 'inicio' : proximaEtapa;
    await pool.query('UPDATE clientes SET etapa=$1 WHERE id=$2', [novaEtapa, clienteData.id]);

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());

  } catch (err) {
    console.error(err);
    twiml.message("Desculpe, ocorreu um erro. Tente de novo ou mande *oi* para recomeçar.");
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
