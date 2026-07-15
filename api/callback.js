// Callback del OAuth de ClickUp: intercambia el código por un access token
// y lo entrega al frontend vía fragmento de URL (no queda en logs del servidor).
module.exports = async (req, res) => {
  const fail = (msg) => {
    res.statusCode = 302;
    res.setHeader("Location", "/#auth_error=" + encodeURIComponent(msg));
    res.end();
  };

  const code = req.query.code;
  if (!code) return fail("ClickUp no devolvió el código de autorización");

  try {
    const r = await fetch("https://api.clickup.com/api/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.CLICKUP_CLIENT_ID,
        client_secret: process.env.CLICKUP_CLIENT_SECRET,
        code,
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) return fail(d.err || "ClickUp rechazó la autenticación");

    res.statusCode = 302;
    res.setHeader("Location", "/#cu_token=" + encodeURIComponent(d.access_token));
    res.end();
  } catch {
    return fail("No se pudo contactar a ClickUp");
  }
};
