// POST /api/webhooks/order-paid
//
// Shopify dispara este webhook (topic "orders/paid") cuando un pedido pasa
// a estado de pago "paid". Para el flujo Contra Entrega eso normalmente NO
// pasa al crear el pedido (queda "pending", ver PAYMENT_TERMS_TEMPLATE_ID en
// crear-pedido.js) sino días después, cuando el equipo lo marca a mano en
// el Admin tras cobrar en la puerta.
//
// A pedido explícito: esto NO reemplaza el evento "Purchase" que ya se
// manda (pixel + CAPI) al crear el pedido — ese sigue igual. Este webhook
// manda un evento SEPARADO ("PurchaseConfirmed", no es un evento estándar
// de Meta) con su propio event_id, para que se pueda armar una Conversión
// Personalizada en Meta Ads Manager y optimizar campañas solo contra ventas
// realmente cobradas, sin tocar ni duplicar el conteo del Purchase normal.
//
// Nunca debe poder afectar al pedido en Shopify: cualquier error se
// registra y se responde 200 igual, para que Shopify no reintente sin
// parar un webhook que de todos modos no puede "fallar" del lado del
// pedido (el pedido ya está pagado, pase lo que pase con Meta).

const crypto = require('crypto');

const DEFAULT_META_PIXEL_ID = '1991488321555698';

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Los webhooks de Shopify se verifican con el RAW body (bytes exactos tal
// como los mandó Shopify) — por eso se desactiva el bodyParser de Vercel
// arriba; re-serializar un body ya parseado a JSON no produce los mismos
// bytes (orden de llaves, espacios) y el HMAC no calzaría nunca.
function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const digestBuf = Buffer.from(digest, 'utf8');
  const hmacBuf = Buffer.from(hmacHeader, 'utf8');
  if (digestBuf.length !== hmacBuf.length) return false;
  return crypto.timingSafeEqual(digestBuf, hmacBuf);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function getNoteAttr(order, key) {
  const attrs = order.note_attributes || [];
  const found = attrs.find((a) => a.name === key);
  return found ? found.value : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const rawBody = await readRawBody(req);
  const secret = process.env.SHOPIFY_APP_CLIENT_SECRET;

  if (!verifyShopifyWebhook(rawBody, req.headers['x-shopify-hmac-sha256'], secret)) {
    res.status(401).send('Invalid HMAC');
    return;
  }

  let order;
  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    res.status(400).send('Invalid JSON');
    return;
  }

  // Shopify puede reenviar este webhook en otros cambios del pedido además
  // de "recién pagado" — solo interesa el momento en que de verdad queda
  // pagado.
  if (order.financial_status !== 'paid') {
    res.status(200).send('ignored (financial_status is not paid)');
    return;
  }

  const accessToken = process.env.META_CAPI_TOKEN;
  if (!accessToken) {
    res.status(200).send('ok (META_CAPI_TOKEN no configurado, se ignora)');
    return;
  }
  const pixelId = process.env.META_PIXEL_ID || DEFAULT_META_PIXEL_ID;

  const phoneRaw = order.phone
    || (order.shipping_address && order.shipping_address.phone)
    || (order.customer && order.customer.phone);

  const userData = {};
  if (phoneRaw) userData.ph = [sha256Hex(String(phoneRaw).replace(/\D/g, ''))];
  if (order.email) userData.em = [sha256Hex(order.email)];
  const fbp = getNoteAttr(order, '_fbp');
  const fbc = getNoteAttr(order, '_fbc');
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const lineItems = order.line_items || [];
  const contentIds = lineItems.map((li) => String(li.variant_id));
  const contents = lineItems.map((li) => ({
    id: String(li.variant_id),
    quantity: li.quantity,
    item_price: Number(li.price),
  }));

  const payload = {
    data: [
      {
        event_name: 'PurchaseConfirmed',
        event_time: Math.floor(Date.now() / 1000),
        event_id: 'paid-' + order.name,
        action_source: 'system_generated',
        user_data: userData,
        custom_data: {
          currency: order.currency || 'PEN',
          value: Number(order.total_price),
          order_id: order.name,
          content_type: 'product',
          content_ids: contentIds,
          contents: contents,
        },
      },
    ],
    access_token: accessToken,
  };

  try {
    const response = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error('Meta CAPI (PurchaseConfirmed) respondió con error:', response.status, errText);
    }
  } catch (err) {
    console.error('Meta CAPI (PurchaseConfirmed): fallo de red:', err.message);
  }

  res.status(200).send('ok');
};
