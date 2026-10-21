/**
 * Gambeta Club - límite simple de pedidos por IP (freno básico contra abuso).
 * Vive en la memoria de cada instancia de Vercel: no es perfecto, pero corta los disparos repetidos.
 * El guion bajo en el nombre hace que Vercel NO lo publique como una ruta.
 *
 *   if (limited(req, res, "cotizar", 40, 60000)) return;   // máx. 40 pedidos por minuto y por IP
 */
var hits = new Map();

function ipOf(req) {
  var xf = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || "desconocida";
}

function limited(req, res, name, max, windowMs) {
  var now = Date.now(), key = name + ":" + ipOf(req), h = hits.get(key);
  if (hits.size > 5000) { hits.forEach(function (v, k) { if (v.reset < now) hits.delete(k); }); }
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  if (h.n > max) {
    res.setHeader("Retry-After", String(Math.ceil((h.reset - now) / 1000)));
    res.status(429).json({ error: "Demasiados intentos seguidos. Esperá un minuto y probá de nuevo." });
    return true;
  }
  return false;
}

module.exports = limited;
