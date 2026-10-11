import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { isSumIdShaped } from "../crypto/sumId.js";
import { AppError, unauthorized } from "../errors.js";
import { resolveSummary } from "./linkAccess.js";

const Login = z.object({ email: z.string(), password: z.string() });
const Access = z.object({ token: z.string().trim(), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), role: z.enum(["patient", "caregiver"]) });
const denied = () => unauthorized("invalid_credentials", "The information entered doesn't match our records.");

export function authRouter(ctx: AppContext): Router {
  const r = Router();
  const isLocal = () => ctx.mode === "local-test" || ctx.mode === "local-agentcore";
  // This demo login exists only in the isolated local runner. Production needs an identity provider.
  r.post("/auth/login", (req, res) => {
    const body = Login.parse(req.body);
    if (!isLocal()) throw new AppError(501, "provider_login_not_configured", "Provider email sign-in is not configured. Use the provider API key in Swagger.");
    if (body.email.trim().toLowerCase() !== "rivera@demo.health" || body.password !== "demo1234") throw denied();
    res.json({ role: "doctor", displayName: "Dr. A. Rivera", subtitle: "Internal Medicine", providerKey: ctx.config.PROVIDER_API_KEY });
  });
  // DOB is checked against the real patient repository. Existing summary APIs remain bearer-link APIs.
  r.post("/auth/link", async (req, res) => {
    const body = Access.parse(req.body);
    let token = body.token;
    if (isLocal() && ["demo-token-123", "demo-caregiver-456"].includes(token)) {
      const latest = await ctx.activeLinks.activeForPatient("7", ctx.clock.nowIso());
      if (!latest) throw new AppError(409, "no_local_plan", "Send a writeup for Alex Example first, then use its patient link.");
      token = latest.sumId;
    }
    if (!isSumIdShaped(token)) throw denied();
    const item = await ctx.summaries.get(token);
    const patient = item ? await ctx.patients.getById(item.patientID) : undefined;
    if (!patient || patient.dateOfBirth?.slice(0, 10) !== body.dob) throw denied();
    await resolveSummary(ctx, token);
    res.json({ role: body.role, displayName: body.role === "caregiver" ? (patient.caregiverName ?? "Caregiver") : "Your recovery plan",
      subtitle: body.role === "caregiver" ? "Caregiver · linked to 1 patient" : "Patient", patientId: patient.id, patientToken: token,
      ...(body.role === "caregiver" ? { caregiverPatientIds: [patient.id] } : {}) });
  });
  return r;
}
