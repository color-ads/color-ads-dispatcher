// Proxy a la API de Anthropic. Solo lo pueden usar miembros del workspace de
// Color Ads en ClickUp: se exige un token de ClickUp válido en cada llamada
// para que nadie externo pueda gastar el crédito de la API.
const WORKSPACE_ID = "9013231845";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-ClickUp-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = req.headers["x-clickup-token"];
  if (!token) return res.status(401).json({ error: { message: "Falta el token de ClickUp" } });

  const auth = await fetch("https://api.clickup.com/api/v2/team", {
    headers: { Authorization: token },
  });
  if (!auth.ok) return res.status(401).json({ error: { message: "Token de ClickUp inválido" } });
  const teams = (await auth.json()).teams || [];
  if (!teams.some((t) => String(t.id) === WORKSPACE_ID)) {
    return res.status(403).json({ error: { message: "Tu usuario no pertenece al workspace de Color Ads" } });
  }

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: Math.min(Number(req.body?.max_tokens) || 500, 800),
    system: String(req.body?.system || ""),
    messages: req.body?.messages,
  };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  res.status(response.status).json(data);
};
