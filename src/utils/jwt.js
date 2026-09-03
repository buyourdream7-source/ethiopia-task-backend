const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, phone: user.phone },
    SECRET,
    { expiresIn: "30d" }
  );
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { signToken, verifyToken };
