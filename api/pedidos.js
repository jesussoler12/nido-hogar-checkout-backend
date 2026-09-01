// GET /api/pedidos?token=...
//
// "Centro de impresión": lista los últimos pedidos con botones para abrir la
// nota de pedido o la etiqueta de envío de cada uno con un clic (en vez de
// editar la URL a mano). Cada botón abre /api/documento en pestaña nueva,
// que ya dispara la impresión sola.
//
// Archivo independiente — no toca crear-pedido.js ni documento.js más que
// para reutilizar el mismo helper de conexión a Shopify.

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

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function money(n) {
  const num = Number(n);
  return 'S/ ' + (Number.isFinite(num) ? num.toFixed(2) : '0.00');
}

function getAttr(customAttributes, names, fallback) {
  for (const name of names) {
    const found = (customAttributes || []).find((a) => a.key === name);
    if (found && found.value) return found.value;
  }
  return fallback;
}

const LIST_QUERY = `
  query PedidosRecientes($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes {
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        customer { displayName }
        shippingAddress { address1 city }
        customAttributes { key value }
        totalPriceSet { shopMoney { amount } }
      }
    }
  }
`;

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

  try {
    const data = await shopifyGraphql(LIST_QUERY, { first: 25 });
    const orders = data.orders.nodes;
    const tokenQs = expectedToken ? `&token=${encodeURIComponent(req.query.token)}` : '';

    const rows = orders.map((o) => {
      const numero = o.name.replace('#', '');
      const fecha = new Date(o.createdAt).toLocaleDateString('es-PE', { timeZone: 'America/Lima' });
      const estadoPago = o.displayFinancialStatus === 'PAID' ? 'Pagado' : 'Pendiente';
      const estadoClase = o.displayFinancialStatus === 'PAID' ? 'ok' : 'pend';
      const direccion = o.shippingAddress?.address1 || '—';
      const distrito = getAttr(o.customAttributes, ['Distrito'], '—');
      const destino = getAttr(o.customAttributes, ['Destino de Envio'], 'Lima Metropolitana');
      const referencia = getAttr(o.customAttributes, ['Referencia Entrega'], '');
      return `
        <tr>
          <td class="num">${esc(o.name)}</td>
          <td>${esc(o.customer?.displayName || 'Clientes Varios')}</td>
          <td class="entrega">
            <div class="entrega-linea">${esc(direccion)}</div>
            <div class="entrega-sub">${esc(distrito)} · ${esc(destino)}${referencia ? ' · Ref: ' + esc(referencia) : ''}</div>
          </td>
          <td>${fecha}</td>
          <td class="num">${money(o.totalPriceSet.shopMoney.amount)}</td>
          <td><span class="badge ${estadoClase}">${estadoPago}</span></td>
          <td class="actions">
            <a class="btn btn-nota" href="/api/documento?pedido=${numero}&tipo=nota${tokenQs}" target="_blank" rel="noopener">🧾 Nota</a>
            <a class="btn btn-etiqueta" href="/api/documento?pedido=${numero}&tipo=etiqueta${tokenQs}" target="_blank" rel="noopener">🏷️ Etiqueta</a>
          </td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Centro de impresión — Nido Hogar</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #FAF8F3; color: #1B2E28; padding: 24px 16px 60px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { font-size: 13px; color: #6E685C; margin: 0 0 20px; }
  table { width: 100%; border-collapse: collapse; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
  th { text-align: left; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: #6E685C; padding: 12px 14px; border-bottom: 1.5px solid #EAE6DF; }
  th.num, td.num { text-align: right; }
  td { padding: 12px 14px; font-size: 13.5px; border-bottom: 1px solid #EAE6DF; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .badge { display: inline-block; padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .badge.ok { background: #ECFDF5; color: #047857; }
  .badge.pend { background: #FBEAE6; color: #8A2E17; }
  .actions { white-space: nowrap; }
  .entrega { max-width: 220px; }
  .entrega-linea { font-weight: 600; }
  .entrega-sub { font-size: 11.5px; color: #6E685C; margin-top: 2px; }
  .btn { display: inline-block; padding: 6px 10px; border-radius: 7px; font-size: 12px; font-weight: 700; text-decoration: none; margin-right: 6px; }
  .btn-nota { background: #1A3B31; color: #FFFFFF; }
  .btn-etiqueta { background: #F3F4F6; color: #1B2E28; border: 1px solid #EAE6DF; }
  .btn-batch { display: inline-block; padding: 10px 16px; border-radius: 8px; font-size: 13.5px; font-weight: 700; text-decoration: none; background: #A8471F; color: #FFFFFF; margin-bottom: 18px; }
  .batch-note { font-size: 12px; color: #6E685C; margin: -12px 0 20px; }
  @media (max-width: 640px) {
    table, thead, tbody, tr { display: block; }
    thead { display: none; }
    tr { background: #FFFFFF; border-radius: 10px; margin-bottom: 10px; padding: 10px 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
    td { border: none; padding: 4px 0; display: flex; justify-content: space-between; }
    td.actions { justify-content: flex-start; margin-top: 8px; }
  }
</style></head>
<body>
  <h1>Centro de impresión</h1>
  <p class="sub">Últimos ${orders.length} pedidos — un clic abre e imprime directo.</p>
  <a class="btn-batch" href="/api/documento?tipo=etiquetas-pagadas${tokenQs}" target="_blank" rel="noopener">🏷️ Imprimir todas las etiquetas pagadas</a>
  <p class="batch-note">Solo pedidos pagados y aún no despachados — cada uno en su propia hoja, listo para imprimir de una vez.</p>
  <table>
    <thead><tr><th>Pedido</th><th>Cliente</th><th>Entrega</th><th>Fecha</th><th class="num">Total</th><th>Pago</th><th>Imprimir</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).send('Error cargando pedidos: ' + err.message);
  }
};
