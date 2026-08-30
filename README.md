# Nido Hogar — Backend Contra Entrega

Backend serverless (Vercel) que recibe el pedido armado desde el tema de Shopify,
crea una **orden real** en Shopify vía Admin API (Draft Orders → completar) y
devuelve el número de orden para que el frontend abra WhatsApp con el mensaje
pre-armado.

## 1. Crear la Custom App en Shopify (para obtener el Admin API token)

Este backend usa una **Custom App creada directamente en el Admin de tu
tienda**, con un token de Admin API fijo (`shpat_...`) — no expira y no
requiere ningún flujo OAuth.

**Importante:** no uses una app del Dev Dashboard (`dev.shopify.com`) con
"client credentials grant" — ese mecanismo **solo funciona con tiendas de
desarrollo dentro de tu misma organización de Partners**, no con tu tienda
real (`nidohogar-peru.myshopify.com`). Es la causa exacta del error
`application_cannot_be_found` si lo intentas — ver la nota de Shopify:
["Acting on another organization's stores"](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).

1. En el Admin de Shopify: **Configuración → Apps y canales de venta →
   Desarrollar apps**.
2. Si es la primera vez, habilita "Permitir desarrollo de apps
   personalizadas".
3. **Crear una app** → dale un nombre, ej. `Nido Hogar — Checkout COD`.
4. Pestaña **Configuración de API** → **Configurar Admin API scopes** y
   marca:
   - `write_draft_orders`
   - `read_draft_orders`
   - `write_orders`
   - `read_orders`
   - `write_payment_terms` (opcional pero recomendado — ver nota abajo)
5. **Guardar**, luego pestaña **Credenciales de API** → **Instalar app**.
6. Copia el **Admin API access token** (empieza con `shpat_...`) — solo se
   muestra una vez. Ese es tu `SHOPIFY_ADMIN_TOKEN` — no lo confundas con
   claves de otros servicios (ej. Stripe, que empiezan con `sk_live_`).

### Nota importante sobre el estado de pago de la orden

Al completar un Draft Order sin pasar por una pasarela de pago, Shopify lo
marca por defecto como **"Paid"** (pagado) — aunque en este flujo el saldo
real se cobra contra entrega, fuera de Shopify. Esto es un comportamiento real
de la Admin API que se detectó probando el flujo completo contra la tienda.

Este backend intenta corregirlo fijando los términos de pago del pedido a
**"Due on fulfillment"** (a pagar al recibir), lo que requiere el scope
`write_payment_terms`. Si tu Custom App no tiene ese scope, el código lo
detecta automáticamente y crea el pedido de todos modos (sin bloquear la
venta), solo que quedará marcado como "Paid" en vez de "Pendiente". Si quieres
que el estado de pago sea el correcto, agrega ese scope al crear la Custom App.

## 2. Desplegar en Vercel

1. Sube esta carpeta a un repositorio (GitHub/GitLab/Bitbucket) — necesitas
   iniciar un repo git nuevo aquí (`git init`) si no existe uno todavía.
2. En [vercel.com](https://vercel.com) → **Add New → Project** → importa el repo.
3. Antes de desplegar (o después, en **Settings → Environment Variables**),
   agrega:
   - `SHOPIFY_STORE_DOMAIN` = `nidohogar-peru.myshopify.com`
   - `SHOPIFY_ADMIN_TOKEN` = el `shpat_...` del paso 1
   - `ALLOWED_ORIGIN` = `https://nidohogar-peru.myshopify.com` (o tu dominio
     propio si usas uno, ej. `https://www.nidohogar.pe`)
   - `CHECKOUT_SHARED_SECRET` = un valor largo y aleatorio que solo tú
     conoces. Protege el endpoint para que nadie más pueda llamarlo
     directamente y crear órdenes falsas — ver nota de seguridad abajo.
4. Despliega. Tu endpoint quedará en algo como:
   `https://nido-hogar-checkout-backend.vercel.app/api/crear-pedido`

## 3. Conectar el frontend

En el tema de Shopify ya se creó la sección `nido-checkout-cod.liquid` y una
página real, **"Finalizar Pedido"** (`/pages/finalizar-pedido`), que la usa.
En el editor de temas, abre esa página → sección "Nido Checkout COD" →
**"URL del backend"** — pega ahí la URL completa del paso anterior
(`https://tu-proyecto.vercel.app/api/crear-pedido`).

## 4. Cómo probarlo

1. Agrega un producto al carrito en la tienda.
2. Entra a `/pages/finalizar-pedido`.
3. Llena el formulario y presiona "Finalizar pedido".
4. Si todo sale bien: se abre WhatsApp con el mensaje armado, y en el Admin de
   Shopify → Pedidos aparece la orden real con los atributos personalizados
   (Tipo, Total por Cobrar en Puerta, etc.) visibles en el detalle del
   pedido, y el stock del producto descontado.

### Ya se probó el flujo completo contra tu tienda real

Antes de entregarte esto, se ejecutaron directamente las mismas mutaciones que
usa este backend (`draftOrderCreate` + `draftOrderComplete`) contra
`nidohogar-peru.myshopify.com`, con datos de cliente ficticios, para
confirmar que Shopify acepta la estructura exacta del pedido:

- Se creó y completó una orden real de prueba: **pedido `#1002`**, sobre el
  producto "Soporte de Baño para Bebé" (1 unidad, de 200 en stock).
- Se confirmó en el pedido resultante: `customAttributes` correctos
  (Tipo, Total por Cobrar en Puerta, Metodo de Pago, Paga con Billete, Vuelto
  Requerido, Referencia Entrega), dirección de envío, teléfono, y
  **descuento real de stock** (200 → 199 unidades).
- Esa prueba fue la que reveló los dos problemas ya corregidos en el código:
  el formato de teléfono (Shopify exige `+51987654321`, no `987654321`) y el
  estado de pago "Paid" por defecto (ver nota arriba).

**Pendiente de tu parte:** el pedido `#1002` es una orden real de prueba y
quedó marcada como "Paid" (antes de aplicar el fix de payment terms). No pude
cancelarla yo mismo — cancelar/reembolsar órdenes está bloqueado por política
de seguridad de la integración que uso para administrar tu tienda. Entra a
**Admin → Pedidos → #1002** y cancélala manualmente (con "restock" activado)
para que el stock y tus reportes queden limpios.

## Notas de seguridad

- `SHOPIFY_ADMIN_TOKEN` vive **solo** en las variables de entorno de Vercel.
  Nunca lo pongas en el tema, en `settings_data.json`, ni en ningún archivo
  que se suba al repositorio del tema.
- El endpoint valida los datos recibidos antes de tocar la Admin API — no confía
  ciegamente en lo que mande el frontend.
- CORS está restringido al dominio configurado en `ALLOWED_ORIGIN`, pero eso
  **no es autenticación real**: solo bloquea llamadas hechas desde JS de otro
  sitio en un navegador, no un POST directo (curl, Postman, un script) contra
  la URL del endpoint. Por eso existe `CHECKOUT_SHARED_SECRET`:
  - Configúralo en Vercel con un valor largo y aleatorio.
  - Haz que la sección del tema envíe ese mismo valor en cada request como
    header `X-Checkout-Token`.
  - Mientras la variable no esté configurada en Vercel, el endpoint sigue
    aceptando requests sin el header (para no romper el checkout mientras
    actualizas el tema) — configúrala en cuanto el tema esté actualizado.
- Para evitar pedidos duplicados por doble clic o reintento de red, el
  frontend puede mandar un `idempotencyKey` (string, hasta 80 caracteres,
  solo letras/números/`-`/`_`) generado una vez por intento de checkout
  (ej. un UUID). Si dos requests llegan con la misma key, la segunda devuelve
  la orden ya creada (`deduped: true`) en vez de crear una nueva.
