import jwt from "jsonwebtoken";
import { User } from "../models/index.js";

// Accept whichever secret name is present in the environment. The project's
// .env ships JWT_SECRET_KEY / AIVET_JWT_SECRET, but JWT_SECRET is also honored.
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.JWT_SECRET_KEY ||
  process.env.AIVET_JWT_SECRET;

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    const token = header.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(payload.sub).select("-passwordHash");
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

export function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN ?? "30d",
  });
}
