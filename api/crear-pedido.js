// POST /api/crear-pedido
//
// Recibe el carrito + datos de entrega + método de pago del saldo desde el
// frontend del tema Shopify, crea un Draft Order real vía Admin API (GraphQL),
// lo completa (queda como Order real, descuenta stock) y devuelve el número
// de orden para que el frontend arme el mensaje de WhatsApp.
//
// El pago real (adelanto S/10 por Yape + saldo contra entrega) NUNCA pasa por
// Shopify Payments: la orden queda con estado de pago "pending" (a cobrar),
// y todo el rastro de cómo se pagará queda en customAttributes (note attributes).

const SHOPIFY_API_VERSION = '2026-07';

const REQUIRED_ENV = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_APP_CLIENT_ID',
  'SHOPIFY_APP_CLIENT_SECRET',
  'YAPE_NUMERO',
  'YAPE_TITULAR',
];

// Las apps creadas en el Dev Dashboard de Shopify no entregan un Admin API
// token estático: el token se obtiene vía "client credentials grant" y
// expira a las 24h (expires_in). Se cachea en memoria dentro de la misma
// instancia de la función serverless y se renueva un poco antes de expirar,
// en vez de pedir uno nuevo en cada request.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_APP_CLIENT_ID,
      client_secret: process.env.SHOPIFY_APP_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`No se pudo obtener el token de Admin API: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiresAt = now + (data.expires_in - 300) * 1000; // renovar 5 min antes
  return cachedToken;
}

const METODO_SALDO_LABELS = {
  efectivo: 'Efectivo',
  yape_puerta: 'Yape en puerta',
  pos: 'POS (tarjeta en puerta)',
};

// Sin esto, cualquiera con la URL del endpoint puede crear órdenes reales
// (y descontar stock real) llamando directo por fuera del navegador — CORS
// solo bloquea llamadas hechas desde JS de otro sitio, no un POST directo
// con curl/Postman. Si CHECKOUT_SHARED_SECRET no está configurada, el
// endpoint queda como antes (sin exigir el header) para no romper el
// checkout mientras el tema todavía no envía el header.
function isAuthorized(req) {
  const expected = process.env.CHECKOUT_SHARED_SECRET;
  if (!expected) return true;
  return req.headers['x-checkout-token'] === expected;
}

function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Checkout-Token');
}

function money(n) {
  const num = Number(n);
  return 'S/ ' + (Number.isFinite(num) ? num.toFixed(2) : '0.00');
}

function toVariantGid(variantId) {
  const idStr = String(variantId);
  return idStr.startsWith('gid://') ? idStr : `gid://shopify/ProductVariant/${idStr}`;
}

// Shopify exige el teléfono en formato E.164 (ej. +51987654321). Los clientes
// normalmente solo escriben los 9 dígitos del celular peruano, así que se
// asume código de país +51 salvo que ya venga con "+".
function toE164Peru(phone) {
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('51') && digits.length > 9) return `+${digits}`;
  return `+51${digits}`;
}

// ID estándar de Shopify para el template de términos de pago "Due on fulfillment"
// (pagar al recibir). Sin esto, draftOrderComplete marca la orden como "Paid" por
// defecto, lo cual es incorrecto para este flujo: el adelanto se paga por Yape FUERA
// de Shopify y el saldo se cobra en la entrega, así que la orden debe quedar pendiente.
const PAYMENT_TERMS_TEMPLATE_ID_DUE_ON_FULFILLMENT = 'gid://shopify/PaymentTermsTemplate/9';

async function shopifyGraphql(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = await getAccessToken();
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await response.json();

  if (!response.ok) {
    const message = json?.errors ? JSON.stringify(json.errors) : `HTTP ${response.status}`;
    throw new Error(`Shopify Admin API error: ${message}`);
  }
  if (json.errors) {
    throw new Error(`Shopify Admin API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function validatePayload(body) {
  const errors = [];

  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push('items debe ser un arreglo con al menos un producto.');
  } else {
    body.items.forEach((item, i) => {
      if (!item.variantId) errors.push(`items[${i}].variantId es obligatorio.`);
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        errors.push(`items[${i}].quantity debe ser un entero mayor a 0.`);
      }
    });
  }

  const cliente = body.cliente || {};
  ['nombre', 'celular', 'direccion', 'distrito'].forEach((field) => {
    if (!cliente[field] || !String(cliente[field]).trim()) {
      errors.push(`cliente.${field} es obligatorio.`);
    }
  });

  if (!METODO_SALDO_LABELS[body.metodoSaldo]) {
    errors.push('metodoSaldo debe ser "efectivo", "yape_puerta" o "pos".');
  }

  const total = Number(body.total);
  const saldoRestante = Number(body.saldoRestante);
  if (!Number.isFinite(total) || total <= 0) errors.push('total inválido.');
  if (!Number.isFinite(saldoRestante) || saldoRestante < 0) errors.push('saldoRestante inválido.');

  if (body.metodoSaldo === 'efectivo') {
    const billete = Number(body.billete);
    if (!Number.isFinite(billete) || billete < saldoRestante) {
      errors.push('billete debe ser un número mayor o igual al saldo restante cuando el método es efectivo.');
    }
  }

  if (body.idempotencyKey !== undefined) {
    if (typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(body.idempotencyKey)) {
      errors.push('idempotencyKey debe ser una cadena de hasta 80 caracteres (letras, números, "-" o "_").');
    }
  }

  return errors;
}

// Permite al frontend reintentar (doble clic, red inestable) sin crear dos
// órdenes reales: si ya existe una orden con este tag, se devuelve esa en
// vez de crear una nueva. La key solo pasa por aquí después de validarse en
// validatePayload contra un charset fijo, para no poder alterar la búsqueda.
function idempotencyTag(key) {
  return `idem-${key}`;
}

async function findOrderByIdempotencyKey(key) {
  const data = await shopifyGraphql(
    `query OrdersByTag($query: String!) {
      orders(first: 1, query: $query) {
        edges { node { id name } }
      }
    }`,
    { query: `tag:'${idempotencyTag(key)}'` }
  );
  const edge = data.orders.edges[0];
  return edge ? edge.node : null;
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Método no permitido. Usa POST.' });
    return;
  }

  if (!isAuthorized(req)) {
    res.status(401).json({ ok: false, error: 'No autorizado.' });
    return;
  }

  const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missingEnv.length > 0) {
    res.status(500).json({
      ok: false,
      error: `Faltan variables de entorno en el servidor: ${missingEnv.join(', ')}.`,
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ ok: false, error: 'JSON inválido en el cuerpo de la solicitud.' });
      return;
    }
  }
  body = body || {};

  const validationErrors = validatePayload(body);
  if (validationErrors.length > 0) {
    res.status(400).json({ ok: false, error: 'Datos inválidos.', detalles: validationErrors });
    return;
  }

  const {
    items,
    cliente,
    metodoSaldo,
    billete,
    total,
    saldoRestante,
    vuelto,
  } = body;

  const montoAdelanto = Number(process.env.MONTO_ADELANTO || 10);
  const yapeNumero = process.env.YAPE_NUMERO;
  const yapeTitular = process.env.YAPE_TITULAR;

  const lineItems = items.map((item) => ({
    variantId: toVariantGid(item.variantId),
    quantity: item.quantity,
  }));

  const DESTINO_LABELS = { lima: 'Lima Metropolitana', provincia: 'Provincias' };

  const customAttributes = [
    { key: 'Tipo', value: 'Contra Entrega con Reserva' },
    { key: 'Adelanto Requerido', value: `${money(montoAdelanto)} (Yape/Plin)` },
    { key: 'Titular Yape', value: `${yapeTitular} (${yapeNumero})` },
    { key: 'Saldo por Cobrar en Puerta', value: money(saldoRestante) },
    { key: 'Metodo de Saldo', value: METODO_SALDO_LABELS[metodoSaldo] },
    { key: 'Paga con Billete', value: metodoSaldo === 'efectivo' ? money(billete) : 'N/A' },
    { key: 'Vuelto Requerido', value: metodoSaldo === 'efectivo' ? money(vuelto || 0) : 'N/A' },
    { key: 'Destino de Envio', value: DESTINO_LABELS[body.destino] || 'Lima Metropolitana' },
    { key: 'Referencia Entrega', value: cliente.referencia || '' },
  ];

  const phoneE164 = toE164Peru(cliente.celular);

  const tags = ['Contra Entrega con Reserva'];
  if (body.idempotencyKey) {
    try {
      const existingOrder = await findOrderByIdempotencyKey(body.idempotencyKey);
      if (existingOrder) {
        res.status(200).json({
          ok: true,
          order_id: existingOrder.id,
          order_number: existingOrder.name,
          deduped: true,
        });
        return;
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || 'Error verificando pedidos existentes.' });
      return;
    }
    tags.push(idempotencyTag(body.idempotencyKey));
  }

  const draftOrderInput = {
    lineItems,
    email: cliente.email || undefined,
    phone: phoneE164,
    note: `Pedido Contra Entrega con Reserva. Total: ${money(total)}. Adelanto: ${money(montoAdelanto)}. Saldo en puerta: ${money(saldoRestante)}.`,
    tags,
    customAttributes,
    paymentTerms: {
      paymentTermsTemplateId: PAYMENT_TERMS_TEMPLATE_ID_DUE_ON_FULFILLMENT,
    },
    shippingAddress: {
      firstName: cliente.nombre,
      address1: cliente.direccion,
      address2: cliente.referencia || undefined,
      city: cliente.distrito,
      countryCode: 'PE',
      phone: phoneE164,
    },
  };

  const CREATE_DRAFT_ORDER_MUTATION = `mutation CreateDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }`;

  try {
    let createData = await shopifyGraphql(CREATE_DRAFT_ORDER_MUTATION, { input: draftOrderInput });
    let createErrors = createData.draftOrderCreate.userErrors;

    // La Custom App puede no tener el scope para fijar payment terms
    // (requiere `write_payment_terms`). Si falla específicamente por eso,
    // reintentamos sin paymentTerms en vez de bloquear el pedido completo —
    // el rastro de "quién debe qué" ya queda igual en customAttributes.
    const isPaymentTermsPermissionError = createErrors.some((e) =>
      /condiciones de pago|payment terms/i.test(e.message)
    );
    if (isPaymentTermsPermissionError) {
      const { paymentTerms, ...inputWithoutPaymentTerms } = draftOrderInput;
      createData = await shopifyGraphql(CREATE_DRAFT_ORDER_MUTATION, { input: inputWithoutPaymentTerms });
      createErrors = createData.draftOrderCreate.userErrors;
    }

    if (createErrors.length > 0) {
      res.status(422).json({
        ok: false,
        error: 'Shopify rechazó los datos del pedido.',
        detalles: createErrors,
      });
      return;
    }

    const draftOrderId = createData.draftOrderCreate.draftOrder.id;

    const completeData = await shopifyGraphql(
      `mutation CompleteDraftOrder($id: ID!) {
        draftOrderComplete(id: $id) {
          draftOrder {
            id
            name
            order { id name legacyResourceId }
          }
          userErrors { field message }
        }
      }`,
      { id: draftOrderId }
    );

    const completeErrors = completeData.draftOrderComplete.userErrors;
    if (completeErrors.length > 0) {
      res.status(422).json({
        ok: false,
        error: 'El pedido se creó como borrador pero no se pudo completar automáticamente. Complétalo manualmente desde el Admin de Shopify.',
        detalles: completeErrors,
        draft_order_id: draftOrderId,
      });
      return;
    }

    const order = completeData.draftOrderComplete.draftOrder.order;
    if (!order) {
      res.status(500).json({
        ok: false,
        error: 'El borrador se completó pero Shopify no devolvió la orden resultante.',
        draft_order_id: draftOrderId,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      order_id: order.id,
      order_number: order.name,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Error inesperado al crear el pedido.' });
  }
};
