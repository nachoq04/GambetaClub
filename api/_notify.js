/**
 * Gambeta Club - aviso de pedido nuevo por Telegram.
 * Si no están definidas TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en Vercel, no hace nada (no rompe nada).
 * Los pedidos de prueba (entornos de preview) no avisan, salvo que definas NOTIFY_TEST=1.
 * Nunca lanza errores: si Telegram falla, la compra sigue igual.
 */
var O = require("./_orders.js");

function money(n) { return "$" + Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "."); }

async function notify(text) {
  var token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  if (O.isTest() && process.env.NOTIFY_TEST !== "1") return false;
  try {
    var r = await O.timedFetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 3500), disable_web_page_preview: true })
    });
    if (!r.ok) console.warn("[notify] Telegram respondió " + r.status);
    return r.ok;
  } catch (e) { console.warn("[notify]", e.message); return false; }
}

/** Pedido nuevo por transferencia o efectivo (queda pendiente de cobro). */
function newOrderText(o, base) {
  var items = (o.items || []).map(function (i) { return "- " + i.qty + " x " + i.name + " (" + i.size + ")"; }).join("\n");
  return (O.isTest() ? "[PRUEBA] " : "") + "Nuevo pedido " + o.ref + "\n" +
    o.name + (o.phone ? " · " + o.phone : "") + "\n" + items + "\n" +
    "Total " + money(o.total) + " · " + o.payment_method + "\n" +
    (o.delivery === "envio" ? "Envío: " + (o.ship_label || "") + (o.address ? " · " + o.address : "") : "Retiro en Libertador San Martín") + "\n" +
    "Panel: " + base + "/pedidos.html";
}

/** Pago acreditado en Mercado Pago. */
function paidText(ref, amount, base, review) {
  return (O.isTest() ? "[PRUEBA] " : "") + (review ? "Pago a revisar " : "Pago acreditado ") + ref + "\n" +
    "Monto " + money(amount) + " (Mercado Pago)\n" + (review ? "El monto es menor al total, revisalo antes de enviar.\n" : "") +
    "Panel: " + base + "/pedidos.html";
}

function base(req) { try { return O.siteBase(req); } catch (e) { return ""; } }

module.exports = { base: base, notify: notify, newOrderText: newOrderText, paidText: paidText };
