import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { lookupRole, type Role } from "./chain.ts";
import { env } from "./env.ts";
import { HttpError } from "./http.ts";

// The session token only proves wallet ownership (issued by the Identity Service after
// a Sign-In with Ethereum signature). Roles are always read live from ParticipantRegistry,
// so approvals and suspensions take effect immediately.

export type AuthedRequest = Request & { wallet: string; role: Role | null };

export function signSession(wallet: string) {
  return jwt.sign({ sub: wallet }, env.JWT_SECRET, { expiresIn: "8h", algorithm: "HS256" });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  let wallet: string;
  try {
    wallet = (jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }) as jwt.JwtPayload).sub!;
  } catch {
    throw new HttpError(401, "Sign in required");
  }
  (req as AuthedRequest).wallet = wallet;
  (req as AuthedRequest).role = await lookupRole(wallet);
  next();
}

/** Use after requireAuth. */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = (req as AuthedRequest).role;
    if (!role || !roles.includes(role)) throw new HttpError(403, `Requires role: ${roles.join(" or ")}`);
    next();
  };
}
