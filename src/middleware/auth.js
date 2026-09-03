const { verifyToken } = require("../utils/jwt");

/** Requires a valid Bearer token. Attaches { id, role, phone } to req.user. */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, role: payload.role, phone: payload.phone };
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Use after requireAuth. Restricts a route to specific roles. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to do that" });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
