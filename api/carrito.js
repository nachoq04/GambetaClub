/**
 * Gambeta Club - guarda el carrito de quien ya dejó su teléfono, para poder ayudarlo si no termina la compra.
 *
 *   POST /api/carrito   { session, name, phone, items: [{id,size,quantity}] }
 *
 * Los precios se leen de la base (nunca del navegador). Los carritos se ven en el panel (pestaña Carritos)
 * y pasan a "convertido" solos cuando el cliente completa el pedido.
 * Si falta ORDERS_SECRET no hace nada y responde igual, para no molestar a quien compra.
 */
var O = require("./_orders.js");
var limited = require("./_limit.js");

function clean(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n); }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(204).end(); }
  if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); return res.status(405).json({ error: "Método no permitido" }); }
  if (limited(req, res, "carrito", 20, 60000)) return;

  try {
    var body = O.parseBody(req);
    var session = clean(body.session, 40), phone = clean(body.phone, 30);
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(session)) throw O.fail(400, "Sesión inválida.");
    if (phone.replace(/\D/g, "").length < 8) throw O.fail(400, "Teléfono inválido.");
    if (!O.ordersEnabled()) return res.status(200).json({ saved: false });

    var cart = await O.buildCart(body);
    await O.rpc("save_cart", { p: {
      session_id: session, name: clean(body.name, 80), phone: phone, total: cart.subtotal, is_test: O.isTest(),
      items: cart.details.map(function (d) { return { id: d.id, name: d.name, size: d.size, qty: d.qty, unit_price: d.unit }; })
    } });
    return res.status(200).json({ saved: true });
  } catch (e) {
    var status = e.status || (e.name === "AbortError" ? 504 : 500);
    if (!e.status || status >= 500) console.error("[carrito]", e.message);
    return res.status(status).json({ error: e.status && e.status < 500 ? e.message : "No se pudo guardar el carrito." });
  }
};
