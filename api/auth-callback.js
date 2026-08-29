// GET /api/auth-callback
//
// Contraparte de api/install.js: recibe el código de autorización que
// Shopify manda de vuelta, lo canjea por un Admin API access token offline
// (no expira) usando el flujo "authorization code grant", y lo muestra en
// pantalla para copiarlo a mano a SHOPIFY_ADMIN_TOKEN en Vercel.
// Borrar este archivo y api/install.js una vez obtenido el token.

const crypto = require('crypto');

function verifyHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac || typeof hmac !== 'string') return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${Array.isArray(rest[key]) ? rest[key].join(',') : rest[key]}`)
    .join('&');

  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const digestBuf = Buffer.from(digest, 'utf8');
  const hmacBuf = Buffer.from(hmac, 'utf8');

  if (digestBuf.length !== hmacBuf.length) return false;
  return crypto.timingSafeEqual(digestBuf, hmacBuf);
}

module.exports = async (req, res) => {
  const { code, shop } = req.query;
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET;

  if (!code || !shop) {
    res.status(400).send('Faltan parámetros code/shop en el callback de Shopify.');
    return;
  }

  if (!verifyHmac(req.query, clientSecret)) {
    res.status(401).send('HMAC inválido — esta petición no viene realmente de Shopify.');
    return;
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });

  const data = await response.json();

  if (!response.ok) {
    res.status(500).send(`<pre>Error canjeando el código por un token:\n${JSON.stringify(data, null, 2)}</pre>`);
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`
    <pre style="font-size:15px; padding:24px; white-space:pre-wrap; word-break:break-all; font-family:monospace;">
Instalación completa para ${shop}.

Copia este token y pégalo en Vercel como SHOPIFY_ADMIN_TOKEN, luego redespliega.
Después de confirmar que funciona, borra api/install.js y api/auth-callback.js de este repo.

Access token:
${data.access_token}

Scopes concedidos:
${data.scope}
    </pre>
  `);
};
