// POST /api/track-event
//
// Respaldo server-side (Conversions API) para los eventos de Meta que hasta
// ahora solo se mandaban por Pixel del navegador: ViewContent, AddToCart e
// InitiateCheckout (ver snippets/nido-checkout-modal.liquid y
// layout/theme.liquid en el tema). Sin este respaldo, cualquier bloqueador
// de anuncios/cookies de terceros o Safari con ITP hace que Meta pierda esa
// señal por completo — igual que ya se resolvió para Purchase en
// crear-pedido.js.
//
// El tema debe generar un `event_id` único por acción del usuario (ej. un
// UUID) y mandar EXACTAMENTE el mismo valor en la llamada a fbq('track', ...)
// del navegador (como tercer argumento {eventID}) y en el POST a este
// endpoint — así Meta deduplica ambos envíos como un solo evento, en vez de
// contarlo dos veces (mismo patrón que ya usa Purchase con `order.name`).
//
// Nunca debe poder romper la navegación del sitio: cualquier error de red o
// de la API de Meta se registra pero se ignora, y el endpoint responde 200
// incluso si el envío a Meta falla — es telemetría, no lógica de negocio.

const ALLOWED_EVENTS = new Set(['ViewContent', 'AddToCart', 'InitiateCheckout']);

function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

  const { event_name: eventName, event_id: eventId } = body;

  if (!ALLOWED_EVENTS.has(eventName)) {
    res.status(400).json({
      ok: false,
      error: `event_name debe ser uno de: ${Array.from(ALLOWED_EVENTS).join(', ')}.`,
    });
    return;
  }
  if (!eventId || typeof eventId !== 'string') {
    res.status(400).json({ ok: false, error: 'event_id es obligatorio (debe coincidir con el eventID que mandó el Pixel del navegador).' });
    return;
  }

  const accessToken = process.env.META_CAPI_TOKEN;
  const pixelId = process.env.META_PIXEL_ID;
  if (!accessToken || !pixelId) {
    // No se puede usar un patrón "responder ya, mandar a Meta después": en
    // una función serverless de Vercel, el entorno de ejecución puede
    // congelarse apenas se envía la respuesta, y el fetch pendiente a Meta
    // se pierde en silencio. Por eso se espera (`await`) el envío completo
    // antes de responder, igual que ya hace crear-pedido.js con Purchase.
    res.status(200).json({ ok: true, forwarded: false, reason: 'META_CAPI_TOKEN o META_PIXEL_ID no configurados' });
    return;
  }

  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const clientIp = forwardedFor || req.socket?.remoteAddress;

  const userData = {};
  if (clientIp) userData.client_ip_address = clientIp;
  if (req.headers['user-agent']) userData.client_user_agent = req.headers['user-agent'];
  if (body.fbp) userData.fbp = body.fbp;
  if (body.fbc) userData.fbc = body.fbc;

  const customData = {
    currency: body.currency || 'PEN',
    content_type: body.content_type || 'product',
  };
  if (Array.isArray(body.content_ids)) customData.content_ids = body.content_ids;
  if (Array.isArray(body.contents)) customData.contents = body.contents;
  if (body.value !== undefined) customData.value = Number(body.value);

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: 'website',
        event_source_url: body.event_source_url || 'https://nidohogar-peru.myshopify.com',
        user_data: userData,
        custom_data: customData,
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
    const responseJson = await response.json().catch(() => null);
    if (!response.ok) {
      console.error(`Meta CAPI (${eventName}) respondió con error:`, response.status, JSON.stringify(responseJson));
      res.status(200).json({ ok: true, forwarded: false, status: response.status, error: responseJson });
      return;
    }
    res.status(200).json({ ok: true, forwarded: true, eventsReceived: responseJson && responseJson.events_received });
  } catch (err) {
    console.error(`Meta CAPI (${eventName}): fallo de red:`, err.message);
    res.status(200).json({ ok: true, forwarded: false, reason: err.message });
  }
};
