import { Router } from "express";
import type { AppContext } from "../context.js";
import { toContractPatient } from "../db/repos/patients.js";
import { z } from "zod";
import { AppError } from "../errors.js";

export const PatientDob = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getTime() <= Date.now();
}, "DOB must be a valid past date");
const Registration = z.object({ ID: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), DOB: PatientDob,
  FirstName: z.string().trim().max(100).optional(), LastName: z.string().trim().max(100).optional(),
  email: z.email().optional(), caregiverEmail: z.email().optional(), preferredLanguage: z.enum(["en", "es", "zh", "ar"]).default("en") });

/**
 * The team contract: GET /patients "gets list of patients from the db" and returns ID, DOB,
 * FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName, exactly those
 * keys. The rows come from the team's own patients table (`patientinfo`, PATIENTS_TABLE), which this
 * backend reads. POST registers an ID and DOB. GET /patients/:id adds the active link.
 */
export function patientsRouter(ctx: AppContext): Router {
  const r = Router();

  r.post("/patients", async (req, res) => {
    const body = Registration.parse(req.body);
    let existing = await ctx.patients.getById(body.ID);
    if (existing && existing.dateOfBirth?.slice(0, 10) !== body.DOB) throw new AppError(409, "patient_dob_mismatch", "This patient ID already exists with a different DOB. Check the ID and date of birth.");
    let patient = existing;
    if (!patient) {
      try { patient = await ctx.patients.create({ id: body.ID, dateOfBirth: body.DOB, firstName: body.FirstName, lastName: body.LastName,
        email: body.email, caregiverEmail: body.caregiverEmail, preferredLanguage: body.preferredLanguage }); }
      catch (error) {
        // A simultaneous registration may have inserted the ID after the first read.
        existing = await ctx.patients.getById(body.ID);
        if (!existing) throw error;
        if (existing.dateOfBirth?.slice(0, 10) !== body.DOB) throw new AppError(409, "patient_dob_mismatch", "This patient ID already exists with a different DOB");
        patient = existing;
      }
    }
    await ctx.audit.append({ event: existing ? "patient.matched" : "patient.created", actor: "provider", at: ctx.clock.nowIso() });
    const active = await ctx.activeLinks.activeForPatient(patient.id, ctx.clock.nowIso());
    res.status(existing ? 200 : 201).json({ patient: toContractPatient(patient), created: !existing,
      activeLink: active ? { sumId: active.sumId, link: ctx.patientUrl(active.sumId), expiresAt: active.expiresAt } : null });
  });

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
