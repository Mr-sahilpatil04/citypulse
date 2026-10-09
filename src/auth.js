import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import db from "./db.js";

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("Set JWT_SECRET (16+ chars) in .env");
  process.exit(1);
}
const fail = (status, message) => Object.assign(new Error(message), { status });
const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: "7d" });
const pub = (u) => ({ id: u.id, name: u.name, email: u.email });

export function register({ name, email, password }) {
  name = String(name || "").trim().slice(0, 60);
  email = String(email || "").trim().toLowerCase();
  if (!name) throw fail(400, "Enter your name.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, "Enter a valid email.");
  if (String(password || "").length < 8) throw fail(400, "Password needs at least 8 characters.");
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) throw fail(409, "That email is already registered. Log in instead.");
  const hash = bcrypt.hashSync(password, 10);
  const id = db.prepare("INSERT INTO users(name,email,password_hash) VALUES(?,?,?)").run(name, email, hash).lastInsertRowid;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  return { token: sign(u), user: pub(u) };
}

export function login({ email, password }) {
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(String(email || "").trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ""), u.password_hash)) throw fail(401, "Email or password is wrong.");
  return { token: sign(u), user: pub(u) };
}

function parse(req) {
  const t = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!t) return null;
  try {
    return db.prepare("SELECT * FROM users WHERE id=?").get(jwt.verify(t, SECRET).id) || null;
  } catch { return null; }
}
export const optionalAuth = (req, _res, next) => { req.user = parse(req); next(); };
export const requireAuth = (req, res, next) => {
  req.user = parse(req);
  if (!req.user) return res.status(401).json({ error: "Log in to do this." });
  next();
};
