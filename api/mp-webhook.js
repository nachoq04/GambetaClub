/**
 * Gambeta Club - webhook de Mercado Pago.
 * Mercado Pago llama acá cuando un pago cambia de estado (acreditado, rechazado, devuelto).
 * No se confía en lo que llega en la notificación: se consulta el pago directamente a Mercado Pago
 * con tu Access Token y recién ahí se actualiza el pedido (pendiente -> pagado) y se descuenta el stock.
 *
 * Configuración:
 *   - La URL de aviso (notification_url) se agrega sola al crear cada pago: https://TU-DOMINIO/api/mp-webhook
 *   - Opcional: en Mercado Pago > Tus integraciones > Webhooks, copiá la "clave secreta" y guardala en Vercel como
 *     MP_WEBHOOK_SECRET para validar también la firma de cada aviso.
 */
var crypto = require("crypto");
var O = require("./_orders.js");
var N = require("./_notify.js");

function validSignature(req, dataId) {
  var secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;                                  // sin clave configurada se confía en la consulta a Mercado Pago
  var sig = String(req.headers["x-signature"] || ""), reqId = String(req.headers["x-request-id"] || "");
  var ts = (sig.match(/ts=([^,]+)/) || [])[1], v1 = (sig.match(/v1=([^,]+)/) || [])[1];
  if (!ts || !v1) return false;
  var manifest = "id:" + String(dataId).toLowerCase() + ";request-id:" + reqId + ";ts:" + ts + ";";
  var mine = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  try { return crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(v1)); } catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" || req.method === "HEAD") return res.status(200).send("ok");
  if (req.method !== "POST") return res.status(405).end();

  var q = req.query || {}, body = O.parseBody(req);
  var type = String(q.type || q.topic || body.type || body.topic || "");
  var dataId = String((q["data.id"] || (body.data && body.data.id) || q.id || body.id || "")).trim();

  // Solo interesan los pagos; el resto de avisos (merchant_order, etc.) se confirman sin hacer nada
  if (type !== "payment" || !/^\d{3,20}$/.test(dataId)) return res.status(200).json({ ok: true, ignored: true });
  if (!validSignature(req, dataId)) { console.warn("[mp-webhook] firma inválida"); return res.status(401).json({ error: "firma inválida" }); }

  var token = process.env.MP_ACCESS_TOKEN;
  if (!token || !O.ordersEnabled()) {
    console.error("[mp-webhook] faltan MP_ACCESS_TOKEN u ORDERS_SECRET");
    return res.status(500).json({ error: "no configurado" });          // Mercado Pago reintenta más tarde
  }

  try {
    var r = await O.timedFetch("https://api.mercadopago.com/v1/payments/" + dataId, { headers: { Authorization: "Bearer " + token } });
    if (r.status === 404) return res.status(200).json({ ok: true, ignored: "pago inexistente" });
    if (!r.ok) throw new Error("Mercado Pago " + r.status);
    var p = await r.json();
    var ref = String(p.external_reference || "");
    if (!/^GC-[A-Z0-9]{4,20}$/.test(ref)) return res.status(200).json({ ok: true, ignored: "sin referencia" });
    var result = await O.rpc("confirm_payment", { p_ref: ref, p_payment_id: String(p.id), p_mp_status: String(p.status), p_amount: Number(p.transaction_amount) });
    console.log("[mp-webhook]", ref, p.status, "->", result);
    if (result === "pagado" || result === "revisar") await N.notify(N.paidText(ref, p.transaction_amount, N.base(req), result === "revisar"));
    return res.status(200).json({ ok: true, result: result });
  } catch (e) {
    console.error("[mp-webhook]", e.message);
    return res.status(500).json({ error: "reintentar" });
  }
};
