// POST /api/crear-pedido
//
// Recibe el carrito + datos de entrega + método de pago desde el frontend del
// tema Shopify, crea un Draft Order real vía Admin API (GraphQL), lo completa
// (queda como Order real, descuenta stock) y devuelve el número de orden para
// que el frontend arme el mensaje de WhatsApp.
//
// El pago real (contra entrega, íntegro) NUNCA pasa por Shopify Payments: la
// orden queda con estado de pago "pending" (a cobrar), y todo el rastro de
// cómo se pagará queda en customAttributes (note attributes).

const crypto = require('crypto');

const SHOPIFY_API_VERSION = '2026-07';

// Pixel ya instalado en el tema (layout/theme.liquid) — no depende de una
// variable de entorno para poder mandar eventos aunque META_PIXEL_ID no se
// configure explícitamente en Vercel.
const DEFAULT_META_PIXEL_ID = '1991488321555698';

const REQUIRED_ENV = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_ADMIN_TOKEN',
];

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
// defecto, lo cual es incorrecto para este flujo: el pago se cobra en la entrega,
// fuera de Shopify Payments, así que la orden debe quedar pendiente.
const PAYMENT_TERMS_TEMPLATE_ID_DUE_ON_FULFILLMENT = 'gid://shopify/PaymentTermsTemplate/9';

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
  ['nombre', 'celular', 'direccion', 'distrito', 'ciudad'].forEach((field) => {
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

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

// Meta cuenta con el pixel del navegador para "PageView", pero como esta
// tienda cobra contra entrega, el pedido NUNCA pasa por el checkout nativo
// de Shopify — que es donde normalmente se dispara la conversión "Purchase"
// hacia Meta. Sin esto, Meta ve clics pero nunca compras (ROAS 0.00) aunque
// sí las haya. Se manda servidor-a-servidor (Conversions API) en vez de solo
// el pixel del navegador porque no depende de que el cliente tenga bloqueado
// el pixel/cookies de terceros, y porque el pago contra entrega no tiene un
// evento de "checkout completado" real en el navegador al que engancharse.
//
// Nunca debe poder romper la creación del pedido: cualquier error de red o
// de la API de Meta se registra pero se ignora — el pedido en Shopify ya
// quedó creado, que es lo crítico.
async function sendMetaPurchaseEvent({ req, order, cliente, phoneE164, total, fbp, fbc }) {
  const accessToken = process.env.META_CAPI_TOKEN;
  if (!accessToken) return;

  const pixelId = process.env.META_PIXEL_ID || DEFAULT_META_PIXEL_ID;
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const clientIp = forwardedFor || req.socket?.remoteAddress;

  const userData = {
    ph: [sha256Hex(phoneE164.replace(/\D/g, ''))],
  };
  if (cliente.email) userData.em = [sha256Hex(cliente.email)];
  if (clientIp) userData.client_ip_address = clientIp;
  if (req.headers['user-agent']) userData.client_user_agent = req.headers['user-agent'];
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const payload = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: order.name,
        action_source: 'website',
        event_source_url: 'https://nidohogar-peru.myshopify.com',
        user_data: userData,
        custom_data: {
          currency: 'PEN',
          value: Number(total),
          order_id: order.name,
          content_type: 'product',
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
      console.error('Meta CAPI respondió con error:', response.status, errText);
    }
  } catch (err) {
    console.error('Meta CAPI: fallo de red al enviar el evento Purchase:', err.message);
  }
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
    saldoRestante,
    vuelto,
    bono,
    luckBono,
    exitBono,
  } = body;

  const lineItems = items.map((item) => ({
    variantId: toVariantGid(item.variantId),
    quantity: item.quantity,
  }));

  const DESTINO_LABELS = { lima: 'Lima Metropolitana', provincia: 'Provincias' };

  // El "saldoRestante"/"total" que manda el frontend ya viene neto de TODO:
  // el % que Shopify calculó si el cliente aplicó un código de descuento real
  // (ej. BIENVENIDO15, vía /cart/update.js, código nativo de Shopify — no lo
  // sabe este backend) MÁS el bono del dado y/o de la oferta de salida
  // (variables propias del checkout, esas sí las manda el frontend por
  // separado). Para poder aplicar UN SOLO descuento real al pedido que cierre
  // exactamente esa brecha — sin importar de qué fuente viene — hace falta
  // saber el precio de catálogo VERDADERO (antes de cualquier descuento), y
  // no se puede confiar en el frontend para ese número: si solo se restaban
  // los bonos (como en la primera versión de este fix) y había además un
  // código de descuento aplicado, el pedido real de Shopify se quedaba a
  // mitad de camino (con el código sin aplicar) — el bug que se detectó al
  // probar código 15% + dado + oferta de salida juntos: el Total de Shopify
  // no coincidía con "TOTAL A COBRAR EN LA PUERTA". Por eso se consulta el
  // precio real de cada variante antes de crear el pedido.
  const bonoTotal = Number(bono) || 0;
  // Aproximación de respaldo (no distingue código de descuento vs bono) por
  // si la consulta de precios reales falla — un pedido con un desglose
  // menos preciso es muchísimo mejor que un pedido que no se crea.
  let catalogSubtotal = Number(saldoRestante) + bonoTotal;
  try {
    const variantGids = items.map((item) => toVariantGid(item.variantId));
    const variantPricesData = await shopifyGraphql(
      `query VariantPrices($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant { id price }
        }
      }`,
      { ids: variantGids }
    );
    const priceByVariantId = {};
    (variantPricesData.nodes || []).forEach((node) => {
      if (node && node.id) priceByVariantId[node.id] = Number(node.price);
    });
    const computedSubtotal = items.reduce((sum, item, i) => {
      const price = priceByVariantId[variantGids[i]];
      return price != null && Number.isFinite(price) ? sum + price * item.quantity : sum;
    }, 0);
    if (computedSubtotal > 0) catalogSubtotal = computedSubtotal;
  } catch (err) {
    console.error('No se pudo consultar el precio real de catálogo (usando aproximación):', err.message);
  }

  const luckBonoNum = Number(luckBono) || 0;
  const exitBonoNum = Number(exitBono) || 0;
  // Brecha total entre catálogo y lo que el cliente realmente debe pagar —
  // cubre bonos Y cualquier código de descuento aplicado, sin necesitar que
  // el frontend mande el código o su monto por separado.
  const descuentoTotal = Math.max(catalogSubtotal - Number(saldoRestante), 0);
  // Lo que no explican los bonos conocidos es, por descarte, el código de
  // descuento (o cualquier otro ajuste nativo de Shopify sobre el carrito).
  const descuentoCodigo = Math.max(descuentoTotal - bonoTotal, 0);

  const customAttributes = [
    { key: 'Tipo', value: 'Contra Entrega' },
    { key: 'Distrito', value: cliente.distrito },
    { key: 'Precio Catalogo', value: money(catalogSubtotal) },
  ];
  if (descuentoCodigo > 0) {
    customAttributes.push({ key: 'Codigo de Descuento', value: '-' + money(descuentoCodigo) });
  }
  if (luckBonoNum > 0) {
    customAttributes.push({ key: 'Bono Prueba tu Suerte (dado)', value: '-' + money(luckBonoNum) });
  }
  if (exitBonoNum > 0) {
    customAttributes.push({ key: 'Descuento Oferta de Salida', value: '-' + money(exitBonoNum) });
  }
  if (bonoTotal > 0 && luckBonoNum === 0 && exitBonoNum === 0) {
    // Compatibilidad: pedidos de una versión anterior del frontend que solo
    // mandaba el total combinado sin distinguir la fuente.
    customAttributes.push({ key: 'Bono Sorpresa', value: '-' + money(bonoTotal) });
  }
  customAttributes.push(
    { key: 'TOTAL A COBRAR EN LA PUERTA', value: money(saldoRestante) },
    { key: 'Metodo de Pago', value: METODO_SALDO_LABELS[metodoSaldo] },
    { key: 'Paga con Billete', value: metodoSaldo === 'efectivo' ? money(billete) : 'N/A' },
    { key: 'Vuelto Requerido', value: metodoSaldo === 'efectivo' ? money(vuelto || 0) : 'N/A' },
    { key: 'Destino de Envio', value: DESTINO_LABELS[body.destino] || 'Lima Metropolitana' },
    { key: 'Referencia Entrega', value: cliente.referencia || '' },
  );

  const noteLines = ['Pedido Contra Entrega.'];
  if (descuentoTotal > 0) {
    noteLines.push(`Precio catálogo: ${money(catalogSubtotal)}`);
    if (descuentoCodigo > 0) noteLines.push(`Código de descuento: -${money(descuentoCodigo)}`);
    if (luckBonoNum > 0) noteLines.push(`Bono "Prueba tu suerte" 🎲: -${money(luckBonoNum)}`);
    if (exitBonoNum > 0) noteLines.push(`Descuento oferta de salida 🎁: -${money(exitBonoNum)}`);
    if (descuentoCodigo === 0 && luckBonoNum === 0 && exitBonoNum === 0) {
      noteLines.push(`Descuento aplicado: -${money(descuentoTotal)}`);
    }
  }
  noteLines.push(`>>> TOTAL A COBRAR EN LA PUERTA: ${money(saldoRestante)} <<<`);
  const orderNote = noteLines.join('\n');

  const phoneE164 = toE164Peru(cliente.celular);

  const tags = ['Contra Entrega'];
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
    note: orderNote,
    tags,
    customAttributes,
    paymentTerms: {
      paymentTermsTemplateId: PAYMENT_TERMS_TEMPLATE_ID_DUE_ON_FULFILLMENT,
    },
    // Antes "city" recibía el distrito (ej. "Miraflores"), que Shopify no
    // reconoce como ciudad/zona de envío real — de ahí que "no reconociera
    // bien la ubicación". Ahora "city" lleva la ciudad real (ej. "Lima") y
    // el distrito va en address2, junto con la referencia si existe.
    shippingAddress: {
      firstName: cliente.nombre,
      address1: cliente.direccion,
      address2: [cliente.distrito, cliente.referencia].filter(Boolean).join(' - ') || undefined,
      city: cliente.ciudad,
      countryCode: 'PE',
      phone: phoneE164,
    },
  };

  // Sin esto, el bono/descuento solo quedaba anotado como texto (nota +
  // customAttributes) pero el "Total"/"Pagado" que Shopify muestra arriba
  // del pedido seguía siendo el precio de catálogo íntegro — a simple vista
  // parecía que no hubo descuento y se podía cobrar de más en la puerta. Al
  // aplicar un descuento REAL a nivel de pedido por `descuentoTotal` (que
  // cierra la brecha COMPLETA contra catalogSubtotal, código de descuento
  // incluido — no solo los bonos), el Total oficial de Shopify ya coincide
  // siempre con "TOTAL A COBRAR EN LA PUERTA", sin importar qué combinación
  // de descuentos usó el cliente.
  if (descuentoTotal > 0) {
    const discountParts = [];
    if (descuentoCodigo > 0) discountParts.push(`Código de descuento: -${money(descuentoCodigo)}`);
    if (luckBonoNum > 0) discountParts.push(`Prueba tu suerte: -${money(luckBonoNum)}`);
    if (exitBonoNum > 0) discountParts.push(`Oferta de salida: -${money(exitBonoNum)}`);
    draftOrderInput.appliedDiscount = {
      value: descuentoTotal,
      valueType: 'FIXED_AMOUNT',
      title: 'Descuentos del checkout',
      description: discountParts.length > 0 ? discountParts.join(' · ') : `Descuento aplicado: -${money(descuentoTotal)}`,
    };
  }

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

    await sendMetaPurchaseEvent({
      req,
      order,
      cliente,
      phoneE164,
      total: body.total,
      fbp: body.fbp,
      fbc: body.fbc,
    });

    res.status(200).json({
      ok: true,
      order_id: order.id,
      order_number: order.name,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Error inesperado al crear el pedido.' });
  }
};
