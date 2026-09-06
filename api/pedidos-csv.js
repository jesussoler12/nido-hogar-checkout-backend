// GET /api/pedidos-csv?token=...&max=500
//
// Exporta los pedidos reales de Shopify en CSV para que Google Sheets los
// jale automáticamente con =IMPORTDATA(...) y arme ahí el dashboard de
// rentabilidad (ventas vs costo de envío vs gasto en Meta Ads).
//
// Archivo independiente — no toca crear-pedido.js, documento.js ni
// pedidos.js, solo reutiliza el mismo patrón de conexión a Shopify y el
// mismo token compartido (DOCUMENTOS_SECRET) que ya protege esos endpoints.

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

function getAttr(customAttributes, names, fallback) {
  for (const name of names) {
    const found = (customAttributes || []).find((a) => a.key === name);
    if (found && found.value) return found.value;
  }
  return fallback;
}

function csvField(value) {
  const s = String(value == null ? '' : value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const ORDERS_QUERY = `
  query PedidosParaExportar($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        customer { displayName }
        customAttributes { key value }
        totalPriceSet { shopMoney { amount } }
      }
    }
  }
`;

const ESTADO_PAGO = {
  PAID: 'Pagado',
  PARTIALLY_PAID: 'Parcial',
  PENDING: 'Pendiente',
  REFUNDED: 'Reembolsado',
  PARTIALLY_REFUNDED: 'Reembolso parcial',
  VOIDED: 'Anulado',
  AUTHORIZED: 'Autorizado',
};

const ESTADO_ENVIO = {
  FULFILLED: 'Enviado',
  UNFULFILLED: 'Pendiente',
  PARTIAL: 'Parcial',
  IN_PROGRESS: 'En proceso',
  ON_HOLD: 'En espera',
  SCHEDULED: 'Programado',
};

async function fetchAllOrders(maxOrders) {
  const orders = [];
  let after = null;
  while (orders.length < maxOrders) {
    const data = await shopifyGraphql(ORDERS_QUERY, {
      first: Math.min(250, maxOrders - orders.length),
      after,
    });
    orders.push(...data.orders.nodes);
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return orders;
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

  const maxOrders = Math.min(2000, Number(req.query.max) || 500);

  try {
    const orders = await fetchAllOrders(maxOrders);

    const header = [
      'Fecha',
      'Pedido',
      'Cliente',
      'Distrito',
      'Metodo de Pago',
      'Total Venta',
      'Estado Pago',
      'Estado Envio',
    ];

    const rows = orders.map((o) => {
      // Formato yyyy-mm-dd (hora de Lima) para que Google Sheets lo lea como
      // fecha real sin ambigüedad de local, sin importar el idioma de la hoja.
      const fecha = new Date(o.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
      const distrito = getAttr(o.customAttributes, ['Distrito'], '');
      const metodo = getAttr(o.customAttributes, ['Metodo de Pago'], '');
      return [
        fecha,
        o.name,
        o.customer?.displayName || 'Clientes Varios',
        distrito,
        metodo,
        o.totalPriceSet.shopMoney.amount,
        ESTADO_PAGO[o.displayFinancialStatus] || o.displayFinancialStatus,
        ESTADO_ENVIO[o.displayFulfillmentStatus] || o.displayFulfillmentStatus,
      ]
        .map(csvField)
        .join(',');
    });

    const csv = [header.join(','), ...rows].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(csv);
  } catch (err) {
    res.status(500).send('Error exportando pedidos: ' + err.message);
  }
};
