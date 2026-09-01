// GET /api/documento?pedido=1013&tipo=nota|etiqueta&token=...
//
// Genera, a partir de datos REALES del pedido (consultados en vivo a Shopify),
// una página HTML lista para imprimir (Ctrl+P → Guardar como PDF o imprimir
// directo): "nota" es una nota de pedido (no es comprobante fiscal) y
// "etiqueta" es el sticker de envío 10x15cm con el monto a cobrar contra
// entrega bien visible para el repartidor.
//
// Archivo totalmente independiente de crear-pedido.js — no lo importa ni lo
// modifica, para no arriesgar el checkout que ya funciona en producción.
//
// Protegido con un token compartido (DOCUMENTOS_SECRET) porque los números de
// pedido son consecutivos y adivinables: sin esto, cualquiera podría recorrer
// ?pedido=1001,1002... y ver nombre/dirección/celular real de cada cliente.

const SHOPIFY_API_VERSION = '2026-07';

async function shopifyGraphql(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    const message = json?.errors ? JSON.stringify(json.errors) : `HTTP ${response.status}`;
    throw new Error(`Shopify Admin API error: ${message}`);
  }
  return json.data;
}

function money(n) {
  const num = Number(n);
  return 'S/ ' + (Number.isFinite(num) ? num.toFixed(2) : '0.00');
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getAttr(customAttributes, names, fallback) {
  for (const name of names) {
    const found = (customAttributes || []).find((a) => a.key === name);
    if (found && found.value) return found.value;
  }
  return fallback;
}

const ORDER_QUERY = `
  query DocumentoOrder($query: String!) {
    orders(first: 1, query: $query) {
      nodes {
        name
        createdAt
        customer { displayName phone }
        shippingAddress { address1 address2 city country }
        lineItems(first: 20) {
          nodes { title quantity originalUnitPriceSet { shopMoney { amount } } }
        }
        totalPriceSet { shopMoney { amount } }
        customAttributes { key value }
      }
    }
  }
`;

async function fetchOrder(pedido) {
  const clean = String(pedido || '').replace(/^#/, '').trim();
  if (!clean) return null;
  const data = await shopifyGraphql(ORDER_QUERY, { query: `name:#${clean}` });
  return data.orders.nodes[0] || null;
}

function formatFechaHora(iso) {
  const d = new Date(iso);
  const fecha = d.toLocaleDateString('es-PE', { timeZone: 'America/Lima' });
  const hora = d.toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false });
  return { fecha, hora };
}

function renderNota(order) {
  const { fecha, hora } = formatFechaHora(order.createdAt);
  const cliente = order.customer?.displayName || 'Clientes Varios';
  const direccion = [order.shippingAddress?.address1, order.shippingAddress?.address2, order.shippingAddress?.city]
    .filter(Boolean).join(', ');
  const metodo = getAttr(order.customAttributes, ['Metodo de Pago'], '—');
  const total = order.totalPriceSet.shopMoney.amount;
  const opGravada = (Number(total) / 1.18).toFixed(2);
  const igv = (Number(total) - Number(opGravada)).toFixed(2);

  const itemsRows = order.lineItems.nodes.map((item) => `
        <tr>
          <td>${esc(item.title)}<div class="item-desc">Pago contra entrega</div></td>
          <td class="num">${item.quantity}</td>
          <td class="num">${money(item.originalUnitPriceSet.shopMoney.amount * item.quantity)}</td>
        </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Nota de Pedido ${esc(order.name)} — Nido Hogar</title>
<style>
  @page { size: 80mm 220mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #E9E5DC; font-family: 'Courier New', Courier, monospace; color: #1A1A1A; }
  .ticket { width: 320px; margin: 24px auto; background: #FFFFFF; padding: 22px 20px 26px; box-shadow: 0 6px 24px rgba(0,0,0,0.12); }
  .brand { text-align: center; font-family: -apple-system, sans-serif; font-weight: 800; font-size: 26px; letter-spacing: -0.02em; margin-bottom: 2px; }
  .tagline { text-align: center; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: #6E685C; margin-bottom: 2px; }
  .divider { border: none; border-top: 1px dashed #B9B3A6; margin: 12px 0; }
  .doc-title { text-align: center; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; margin-bottom: 2px; }
  .doc-num { text-align: center; font-size: 10px; color: #6E685C; margin-bottom: 10px; }
  .meta { font-size: 10.5px; line-height: 1.7; }
  .meta .row { display: flex; justify-content: space-between; gap: 8px; }
  .meta .label { color: #6E685C; flex-shrink: 0; }
  .meta .val { text-align: right; }
  table.items { width: 100%; border-collapse: collapse; font-size: 10.5px; margin: 10px 0; }
  table.items th { text-align: left; font-weight: 700; font-size: 9px; letter-spacing: 0.03em; padding-bottom: 4px; border-bottom: 1px solid #1A1A1A; }
  table.items th.num, table.items td.num { text-align: right; }
  table.items td { padding: 6px 0 2px; vertical-align: top; }
  .item-desc { color: #6E685C; font-size: 9.5px; }
  .totals { font-size: 11px; margin-top: 8px; }
  .totals .row { display: flex; justify-content: space-between; padding: 2px 0; }
  .totals .grand { font-weight: 700; font-size: 13px; padding-top: 6px; margin-top: 4px; border-top: 1px solid #1A1A1A; }
  @media print { body { background: #FFFFFF; } .ticket { box-shadow: none; margin: 0; } }
</style></head>
<body>
  <div class="ticket">
    <div class="brand">Nido Hogar</div>
    <div class="tagline">Bienestar para tu hogar</div>
    <div class="tagline" style="margin-top:2px;">RUC 10786344951</div>
    <hr class="divider">
    <div class="doc-title">NOTA DE PEDIDO</div>
    <div class="doc-num">${esc(order.name)}</div>
    <hr class="divider">
    <div class="meta">
      <div class="row"><span class="label">Fecha</span><span class="val">${fecha}</span></div>
      <div class="row"><span class="label">Hora</span><span class="val">${hora}</span></div>
      <div class="row"><span class="label">Cliente</span><span class="val">${esc(cliente)}</span></div>
      <div class="row"><span class="label">Dirección</span><span class="val">${esc(direccion)}</span></div>
    </div>
    <hr class="divider">
    <table class="items">
      <thead><tr><th>Descripción</th><th class="num">Cant.</th><th class="num">Total</th></tr></thead>
      <tbody>${itemsRows}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Op. Gravada</span><span>${money(opGravada)}</span></div>
      <div class="row"><span>IGV (18%)</span><span>${money(igv)}</span></div>
      <div class="row grand"><span>TOTAL A PAGAR</span><span>${money(total)}</span></div>
    </div>
    <div class="meta" style="margin-top:8px;"><div class="row"><span class="label">Forma de pago</span><span class="val">${esc(metodo)}</span></div></div>
  </div>
</body></html>`;
}

function renderEtiqueta(order) {
  const { fecha } = formatFechaHora(order.createdAt);
  const cliente = order.customer?.displayName || 'Clientes Varios';
  const celular = order.customer?.phone || '—';
  const distrito = getAttr(order.customAttributes, ['Distrito'], '');
  const referencia = getAttr(order.customAttributes, ['Referencia Entrega'], '');
  const metodo = getAttr(order.customAttributes, ['Metodo de Pago'], '—');
  const direccion = order.shippingAddress?.address1 || '';
  const ciudad = order.shippingAddress?.city || 'Lima';
  const total = order.totalPriceSet.shopMoney.amount;
  const itemsLine = order.lineItems.nodes.map((i) => `${i.quantity} × ${esc(i.title)}`).join(', ');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Etiqueta ${esc(order.name)} — Nido Hogar</title>
<style>
  @page { size: 100mm 150mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; width: 100mm; height: 150mm; font-family: -apple-system, sans-serif; color: #1A1A1A; background: #FFFFFF; }
  .label { width: 100mm; height: 150mm; padding: 5mm; display: flex; flex-direction: column; }
  .brand-row { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1A1A1A; padding-bottom: 3mm; margin-bottom: 3mm; }
  .brand { font-size: 16px; font-weight: 800; letter-spacing: -0.01em; }
  .order-num { font-size: 11px; font-weight: 700; text-align: right; }
  .order-num small { display: block; font-size: 8px; font-weight: 400; color: #6E685C; }
  .section-label { font-size: 8px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #6E685C; margin-bottom: 1mm; }
  .from-block { font-size: 9px; line-height: 1.5; color: #4A463D; margin-bottom: 3mm; }
  .to-block { border: 1.5px solid #1A1A1A; border-radius: 3px; padding: 3mm; margin-bottom: 3mm; }
  .to-name { font-size: 15px; font-weight: 800; margin-bottom: 1.5mm; }
  .to-line { font-size: 11px; line-height: 1.5; }
  .to-phone { font-size: 12px; font-weight: 700; margin-top: 1.5mm; }
  .cod-box { background: #1A1A1A; color: #FFFFFF; border-radius: 3px; padding: 4mm 3mm; text-align: center; margin-bottom: 3mm; }
  .cod-label { font-size: 9px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; opacity: 0.85; }
  .cod-amount { font-size: 30px; font-weight: 900; letter-spacing: -0.02em; margin-top: 1mm; }
  .cod-method { font-size: 10px; margin-top: 1mm; opacity: 0.9; }
  .items-box { font-size: 10px; line-height: 1.6; border-top: 1px dashed #B9B3A6; padding-top: 2.5mm; margin-bottom: 3mm; }
  .footer-row { margin-top: auto; display: flex; justify-content: space-between; align-items: flex-end; border-top: 1px dashed #B9B3A6; padding-top: 2.5mm; }
  .footer-row .ref { font-size: 8.5px; color: #6E685C; max-width: 60mm; line-height: 1.4; }
  .footer-row .date { font-size: 8.5px; color: #6E685C; text-align: right; white-space: nowrap; }
</style></head>
<body>
  <div class="label">
    <div class="brand-row">
      <div class="brand">Nido Hogar</div>
      <div class="order-num">${esc(order.name)}<small>N.° de pedido</small></div>
    </div>
    <div class="section-label">Remitente</div>
    <div class="from-block">Nido Hogar — RUC 10786344951<br>Jr. Perricholi 275, San Isidro, Lima</div>
    <div class="section-label">Destinatario</div>
    <div class="to-block">
      <div class="to-name">${esc(cliente)}</div>
      <div class="to-line">${esc(direccion)}</div>
      <div class="to-line">${esc(distrito)}${referencia ? ' — Ref: ' + esc(referencia) : ''}</div>
      <div class="to-line">${esc(ciudad)}</div>
      <div class="to-phone">📱 ${esc(celular)}</div>
    </div>
    <div class="cod-box">
      <div class="cod-label">Cobrar contra entrega</div>
      <div class="cod-amount">${money(total)}</div>
      <div class="cod-method">${esc(metodo)}</div>
    </div>
    <div class="items-box">${esc(itemsLine)}</div>
    <div class="footer-row">
      <div class="ref">Entrega: Lima Metropolitana · 24–48h</div>
      <div class="date">${fecha}</div>
    </div>
  </div>
</body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const expectedToken = process.env.DOCUMENTOS_SECRET;
  if (expectedToken && req.query.token !== expectedToken) {
    res.status(401).send('No autorizado. Falta ?token=...');
    return;
  }

  const pedido = req.query.pedido;
  const tipo = req.query.tipo === 'etiqueta' ? 'etiqueta' : 'nota';

  if (!pedido) {
    res.status(400).send('Falta ?pedido=1013');
    return;
  }

  try {
    const order = await fetchOrder(pedido);
    if (!order) {
      res.status(404).send(`No se encontró el pedido #${pedido}`);
      return;
    }
    const html = tipo === 'etiqueta' ? renderEtiqueta(order) : renderNota(order);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Error generando el documento: ' + err.message);
  }
};
