import { Router } from "express";
import type { AppContext } from "../context.js";
import { toContractPatient } from "../db/repos/patients.js";

/**
 * The team contract: GET /patients "gets list of patients from the db" and returns ID, DOB,
 * FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName, exactly those
 * keys. The rows come from the team's own patients table (`patientinfo`, PATIENTS_TABLE), which this
 * backend reads and never writes. GET /patients/:id adds the patient's active link.
 */
export function patientsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get("/patients", async (_req, res) => {
    const patients = await ctx.patients.list();
    res.json({ patients: patients.map(toContractPatient) });
  });

  r.get("/patients/:id", async (req, res) => {
    const p = await ctx.patients.getById(req.params.id);
    if (!p) {
      res.status(404).json({ statusCode: 404, error: "patient_not_found", message: "Unknown patient" });
      return;
    }
    const link = await ctx.activeLinks.activeForPatient(p.id, ctx.clock.nowIso());
    res.json({
      ...toContractPatient(p),
      preferredLanguage: p.preferredLanguage,
      activeLink: link ? { sumId: link.sumId, link: ctx.patientUrl(link.sumId), status: link.status, createdAt: link.createdAt, expiresAt: link.expiresAt } : null,
    });
  });

  return r;
}
