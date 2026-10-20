/**
 * Gambeta Club - Mercado Pago Checkout Pro.
 * Función serverless de Vercel: POST /api/mercadopago
 *
 * Body que manda la tienda:
 *   {
 *     name: "Nombre Apellido", phone: "2964...", address: "Calle 123, Localidad",
 *     delivery: "retiro" | "envio", deliveryLabel: "Retiro en Villa Libertador San Martín",
 *     items: [{ id: "ARG-001", size: "L", quantity: 2 }],
 *     shipping: { cp: "2400", type: "S" | "D" }      // opcional (solo si eligió envío por Correo)
 *   }
 *
 * Por seguridad el precio NUNCA se toma del navegador: se lee cada camiseta en Supabase
 * (precio vigente, promo y stock) y se vuelve a cotizar el envío.
 *
 * Además guarda el pedido en la tabla "orders" (estado: pendiente) y le pide a Mercado Pago
 * que avise a /api/mp-webhook cuando el pago se acredite.
 *
 * Variables de entorno (Vercel > Project > Settings > Environment Variables):
 *   MP_ACCESS_TOKEN   Access Token de Mercado Pago (obligatoria)
 *   ORDERS_SECRET     clave interna para guardar pedidos y confirmar pagos (ver _orders.js)
 *   SITE_URL          opcional, ej: https://gambetaclub.vercel.app
 */
var O = require("./_orders.js");

var MP_URL = "https://api.mercadopago.com/checkout/preferences";

function clean(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n); }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(405).json({ error: "Método no permitido" }); }

  try {
    var token = process.env.MP_ACCESS_TOKEN;
    if (!token) throw O.fail(503, "El pago con Mercado Pago todavía no está disponible. Elegí transferencia o efectivo.");

    var body = O.parseBody(req);
    var name = clean(body.name, 80), phone = clean(body.phone, 30), address = clean(body.address, 160);

    var cart = await O.buildCart(body);
    var shipping = await O.buildShipping(body, cart.shirts);

    var items = cart.details.map(function (d) {
      var item = { id: d.id + "-" + d.size, title: (d.name + " (Talle " + d.size + ")").slice(0, 250), description: "Camiseta " + d.name + ", talle " + d.size,
                   category_id: "fashion", quantity: d.qty, currency_id: "ARS", unit_price: d.unit };
      if (d.picture) item.picture_url = d.picture;
      return item;
    });
    if (shipping) {
      items.push({ id: "ENVIO-" + shipping.type, title: (shipping.label + " (CP " + shipping.cp + ")").slice(0, 250),
                   category_id: "services", quantity: 1, currency_id: "ARS", unit_price: shipping.price });
    }
    var total = cart.subtotal + (shipping ? shipping.price : 0);

    var base = O.siteBase(req), https = /^https:\/\//.test(base) && !/localhost|127\.0\.0\.1/.test(base);
    var ref = O.newRef();
    var preference = {
      items: items,
      payer: name ? { name: name } : undefined,
      back_urls: { success: base + "/?status=success", failure: base + "/?status=failure", pending: base + "/?status=pending" },
      external_reference: ref,
      statement_descriptor: "GAMBETA CLUB",
      metadata: { name: name, shirts: cart.shirts, shipping_cp: shipping && shipping.cp, shipping_type: shipping && shipping.type }
    };
    if (https) {
      preference.auto_return = "approved";                         // Mercado Pago solo lo acepta con URL pública https
      preference.notification_url = base + "/api/mp-webhook";      // aviso de pago acreditado
    }

    var r = await O.timedFetch(MP_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "X-Idempotency-Key": ref + "-" + Math.random().toString(36).slice(2, 10) },
      body: JSON.stringify(preference)
    });
    var mp = await r.json().catch(function () { return {}; });
    if (!r.ok || !mp.init_point) {
      console.error("[mercadopago] error", r.status, JSON.stringify(mp).slice(0, 500));
      throw O.fail(502, "Mercado Pago no pudo generar el pago. Probá de nuevo o elegí otro medio.");
    }

    // Se guarda recién con la preferencia creada, así no quedan pedidos fantasma
    var envio = !!shipping || body.delivery === "envio";
    await O.recordOrder({
      ref: ref, name: name || "Sin nombre", phone: phone, delivery: envio ? "envio" : "retiro",
      delivery_label: clean(body.deliveryLabel, 80) || (envio ? "Envío" : "Retiro"),
      ship_cp: shipping ? shipping.cp : "", ship_type: shipping ? shipping.type : "", ship_label: shipping ? shipping.label : "", address: address,
      items: cart.details.map(function (d) { return { id: d.id, name: d.name, size: d.size, qty: d.qty, unit_price: d.unit }; }),
      subtotal: cart.subtotal, shipping: shipping ? shipping.price : 0, total: total, payment_method: "mercadopago"
    });

    return res.status(200).json({
      id: mp.id, init_point: mp.init_point, sandbox_init_point: mp.sandbox_init_point,
      ref: ref, subtotal: cart.subtotal, shipping: shipping ? shipping.price : 0, total: total
    });
  } catch (e) {
    var status = e.status || (e.name === "AbortError" ? 504 : 500);
    if (!e.status) console.error("[mercadopago]", e);
    return res.status(status).json({ error: e.status ? e.message : (e.name === "AbortError" ? "Mercado Pago tardó demasiado. Probá de nuevo." : "No pudimos generar el pago. Probá de nuevo.") });
  }
};
