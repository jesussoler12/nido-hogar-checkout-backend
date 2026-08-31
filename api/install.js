// GET /api/install
//
// Ruta temporal de un solo uso: redirige al dueño de la tienda a la pantalla
// de autorización de Shopify para conceder acceso a la app ya creada en
// dev.shopify.com, usando el flujo estándar "authorization code grant" (el
// único, junto con token exchange, que funciona con tiendas fuera de la
// organización de Partners — a diferencia del "client credentials grant").
// Borrar este archivo y api/auth-callback.js una vez obtenido el token fijo.

module.exports = (req, res) => {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID;

  if (!shop || !clientId) {
    res.status(500).send('Faltan SHOPIFY_STORE_DOMAIN o SHOPIFY_APP_CLIENT_ID en el entorno.');
    return;
  }

  const scopes = 'write_draft_orders,read_draft_orders,write_orders,read_orders,write_payment_terms,read_products';
  const redirectUri = `https://${req.headers.host}/api/auth/callback`;

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}`;

  res.writeHead(302, { Location: authUrl });
  res.end();
};
