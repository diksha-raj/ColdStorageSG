import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { ZodError } from "zod";
import { env } from "./env.ts";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Express app with the security defaults every service uses. */
export function createApp() {
  const app = express();
  app.use(helmet());
  app.use(cors({ origin: env.FRONTEND_ORIGIN }));
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

/** Registers the error handler and starts listening. Call after all routes are added. */
export function start(app: express.Express, name: string, port: number) {
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid input", details: err.issues });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
    } else if (isContractRevert(err)) {
      res.status(400).json({ error: `Rejected by contract: ${err.reason ?? err.shortMessage}` });
    } else {
      console.error(err);
      res.status(500).json({ error: "Internal error" });
    }
  });
  app.listen(port, () => console.log(`${name} listening on :${port}`));
}

function isContractRevert(err: unknown): err is { reason?: string; shortMessage: string } {
  return typeof err === "object" && err !== null && (err as any).code === "CALL_EXCEPTION";
}
