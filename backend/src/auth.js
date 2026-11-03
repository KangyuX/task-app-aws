import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { query } from "./db.js";

const secret = () => {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
};

export const hashPassword = (pw) => bcrypt.hash(pw, 12);
export const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

export function issueToken(user) {
  return jwt.sign({ sub: String(user.id), name: user.name }, secret(), { expiresIn: "7d" });
}

export function publicUser(u) {
  return { id: Number(u.id), email: u.email, name: u.name };
}

// Express middleware: requires "Authorization: Bearer <token>" for a user that still exists.
export async function requireUser(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in required" });
  let claims;
  try {
    claims = jwt.verify(token, secret());
  } catch {
    return res.status(401).json({ error: "Session expired, please sign in again" });
  }
  const { rows } = await query("SELECT id, email, name FROM users WHERE id = $1", [claims.sub]);
  if (!rows[0]) return res.status(401).json({ error: "Account not found" });
  req.user = publicUser(rows[0]);
  next();
}
