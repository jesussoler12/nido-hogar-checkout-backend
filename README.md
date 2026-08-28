# Nido Hogar — Backend Contra Entrega con Reserva

Backend serverless (Vercel) que recibe el pedido armado desde el tema de Shopify,
crea una **orden real** en Shopify vía Admin API (Draft Orders → completar) y
devuelve el número de orden para que el frontend abra WhatsApp con el mensaje
pre-armado.

## 1. Crear la Custom App en Shopify (para obtener el Admin API token)

1. En el Admin de Shopify: **Configuración → Apps y canales de venta → Desarrollar apps**.
2. Si es la primera vez, habilita "Permitir desarrollo de apps personalizadas".
3. **Crear una app** → dale un nombre, ej. `Nido Hogar — Checkout COD`.
4. Pestaña **Configuración de API** → **Configurar Admin API scopes** y marca:
   - `write_draft_orders`
   - `read_draft_orders`
   - `write_orders`
   - `read_orders`
   - `write_payment_terms` (opcional pero recomendado — ver nota abajo)
5. **Guardar**, luego pestaña **Credenciales de API** → **Instalar app**.
6. Copia el **Admin API access token** (empieza con `shpat_...`) — solo se
   muestra una vez. Ese es tu `SHOPIFY_ADMIN_TOKEN`.

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
   - Opcionales (ya traen default en el código): `MONTO_ADELANTO`,
     `YAPE_NUMERO`, `YAPE_TITULAR`.
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
   (Tipo, Adelanto Requerido, Titular Yape, etc.) visibles en el detalle del
   pedido, y el stock del producto descontado.

### Ya se probó el flujo completo contra tu tienda real

Antes de entregarte esto, se ejecutaron directamente las mismas mutaciones que
usa este backend (`draftOrderCreate` + `draftOrderComplete`) contra
`nidohogar-peru.myshopify.com`, con datos de cliente ficticios, para
confirmar que Shopify acepta la estructura exacta del pedido:

- Se creó y completó una orden real de prueba: **pedido `#1002`**, sobre el
  producto "Soporte de Baño para Bebé" (1 unidad, de 200 en stock).
- Se confirmó en el pedido resultante: `customAttributes` correctos
  (Tipo, Adelanto Requerido, Titular Yape, Saldo por Cobrar en Puerta, Metodo
  Saldo, Paga con Billete, Vuelto a Llevar, Referencia Entrega), dirección de
  envío, teléfono, y **descuento real de stock** (200 → 199 unidades).
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

- El `SHOPIFY_ADMIN_TOKEN` vive **solo** en las variables de entorno de Vercel.
  Nunca lo pongas en el tema, en `settings_data.json`, ni en ningún archivo que
  se suba al repositorio del tema.
- El endpoint valida los datos recibidos antes de tocar la Admin API — no confía
  ciegamente en lo que mande el frontend.
- CORS está restringido al dominio configurado en `ALLOWED_ORIGIN`.
