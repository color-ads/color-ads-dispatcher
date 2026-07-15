// Proxy genérico a la API v2 de ClickUp — evita CORS desde el navegador.
// El token personal del usuario viaja en el header X-ClickUp-Token.
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-ClickUp-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = req.headers["x-clickup-token"];
  if (!token) return res.status(401).json({ err: "Falta el token de ClickUp" });

  const path = req.query.path || "";
  if (!/^[\w/\-.?=&%+]+$/.test(path)) return res.status(400).json({ err: "Ruta inválida" });

  const init = {
    method: req.method,
    headers: { Authorization: token, "Content-Type": "application/json" },
  };
  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    init.body = JSON.stringify(req.body);
  }

  try {
    const r = await fetch(`https://api.clickup.com/api/v2/${path}`, init);
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ err: "No se pudo contactar a ClickUp" });
  }
};
