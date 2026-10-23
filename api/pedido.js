/**
 * Gambeta Club - registro de pedidos (transferencia y efectivo) y consulta de estado.
 *
 *   POST /api/pedido   { name, phone, address, payment: "transferencia" | "efectivo",
 *                        delivery: "retiro" | "envio", deliveryLabel, items: [{id,size,quantity}], shipping: {cp,type} | null }
 *        -> { ref, total }     (el pedido queda en el panel como "En proceso de compra")
 *   GET  /api/pedido?ref=GC-XXXX   -> { status, payment_status }   (lo usa la tienda al volver de Mercado Pago)
 *
 * La tienda llama a esta función antes de abrir WhatsApp. Si falla, el cliente igual puede seguir por WhatsApp.
 */
var O = require("./_orders.js");
var N = require("./_notify.js");
var limited = require("./_limit.js");

function clean(s, n) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n); }

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.setHeader("Allow", "GET, POST, OPTIONS"); return res.status(204).end(); }

  if (limited(req, res, "pedido-" + req.method, req.method === "GET" ? 30 : 8, 60000)) return;
  try {
    if (req.method === "GET") {
      var ref = clean(req.query && req.query.ref, 40);
      if (!/^GC-[A-Z0-9]{4,20}$/.test(ref)) throw O.fail(400, "Referencia inválida.");
      if (!O.ordersEnabled()) return res.status(200).json({ status: null, payment_status: null });
      var st = await O.rpc("order_status", { p_ref: ref });
      return res.status(200).json(st || { status: null, payment_status: null });
    }
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST, OPTIONS"); return res.status(405).json({ error: "Método no permitido" }); }

    var body = O.parseBody(req);
    var payment = body.payment === "efectivo" ? "efectivo" : (body.payment === "transferencia" ? "transferencia" : "");
    if (!payment) throw O.fail(400, "Método de pago inválido.");
    var name = clean(body.name, 80);
    if (!name) throw O.fail(400, "Falta el nombre.");

    var cart = await O.buildCart(body);
    var shipping = await O.buildShipping(body, cart.shirts);
    // la transferencia tiene 5% de descuento solo sobre las camiseta, nunca sobre el envío
    // con 2 o más camisetas ya rige el 10% por cantidad y no se suma el 5% de transferencia
    var transfer = payment === "transferencia" && !cart.bulk;
    var shirtsTotal = transfer
      ? cart.details.reduce(function (s, d) { return s + O.transferPrice(d.unit) * d.qty; }, 0)
      : cart.subtotal;
    var ship = shipping ? shipping.price : 0;
    var ref = O.newRef(), envio = !!shipping || body.delivery === "envio";

    var order = {
      ref: ref, name: name, phone: clean(body.phone, 30), delivery: envio ? "envio" : "retiro",
      delivery_label: clean(body.deliveryLabel, 80) || (envio ? "Envío" : "Retiro"),
      ship_cp: shipping ? shipping.cp : "", ship_type: shipping ? shipping.type : "", ship_label: shipping ? shipping.label : "", address: clean(body.address, 160),
      cart_session: clean(body.cartSession, 40),
      items: cart.details.map(function (d) { return { id: d.id, name: d.name, size: d.size, qty: d.qty, unit_price: transfer ? O.transferPrice(d.unit) : d.unit }; }),
      subtotal: shirtsTotal, shipping: ship, total: shirtsTotal + ship, payment_method: payment
    };
    var saved = await O.recordOrder(order);
    if (saved) await N.notify(N.newOrderText(order, N.base(req)));
    return res.status(200).json({ ref: ref, total: shirtsTotal + ship, saved: saved });
  } catch (e) {
    var status = e.status || (e.name === "AbortError" ? 504 : 500);
    if (!e.status) console.error("[pedido]", e);
    return res.status(status).json({ error: e.status ? e.message : "No pudimos registrar el pedido." });
  }
};
