// Inicia el login OAuth con ClickUp: redirige a la pantalla de autorización.
// Requiere CLICKUP_CLIENT_ID y CLICKUP_CLIENT_SECRET en las env vars de Vercel.
module.exports = (req, res) => {
  const id = process.env.CLICKUP_CLIENT_ID;
  if (!id || !process.env.CLICKUP_CLIENT_SECRET) {
    return res.status(503).json({ err: "OAuth no configurado. Agrega CLICKUP_CLIENT_ID y CLICKUP_CLIENT_SECRET en Vercel." });
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const redirect = `${proto}://${host}/api/callback`;
  res.statusCode = 302;
  res.setHeader("Location", `https://app.clickup.com/api?client_id=${id}&redirect_uri=${encodeURIComponent(redirect)}`);
  res.end();
};
