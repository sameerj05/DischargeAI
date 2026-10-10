// Authentication layer for Discharge AI.
//
// This is a MOCK implementation. Every network seam is marked with a
// `// TODO: replace with real backend call` comment so a real backend
// (provider auth, GET /p/:token, POST /ingest) swaps in without changing
// the component layer. All functions return Promises for exactly this reason.
//
// NOTE ON HIPAA: this mock approximates good practice (no PHI in URLs, no PHI
// in storage, idle timeout, role-based access). True HIPAA compliance is an
// end-to-end property — it requires a BAA-covered backend, encryption in
// transit and at rest, audit logging, and access controls on the server. The
// UI never claims to BE HIPAA compliant; it frames access as protected /
// authorized only.

export type Role = "doctor" | "caregiver" | "patient"

export type Session = {
  role: Role
  displayName: string
  subtitle: string
  // Caregivers are linked to one or more specific patients.
  caregiverPatientIds?: string[]
  // Patients carry an opaque id + token, never name / DOB / MRN.
  patientId?: string
  patientToken?: string
  // Absolute expiry (epoch ms). Used for idle/session timeout.
  exp: number
}

// ── HIPAA constants (configurable, kept together and easy to find) ──

// Idle timeout: auto sign-out after this many ms of no user activity.
// 15 minutes is a common clinical-session guideline. Change here to adjust.
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000

// sessionStorage key for the minimal, non-PHI session marker.
export const SESSION_STORAGE_KEY = "dai.session"

// ── Demo credential tables (mock only) ──
//
// TODO: replace with real backend call — provider auth (POST /auth/login).
// Never ship hardcoded credentials; a real server validates against an IdP.
const DEMO_CREDENTIALS: Record<
  string,
  { password: string; session: Omit<Session, "exp"> }
> = {
  "rivera@demo.health": {
    password: "demo1234",
    session: {
      role: "doctor",
      displayName: "Dr. A. Rivera",
      subtitle: "Internal Medicine",
    },
  },
  "caregiver@demo.health": {
    password: "demo1234",
    session: {
      role: "caregiver",
      displayName: "Jordan Martinez",
      subtitle: "Caregiver · linked to 1 patient",
      caregiverPatientIds: ["p1"],
    },
  },
}

// TODO: replace with real backend call — GET /p/:token validates the opaque
// token and returns the patient's session + discharge content.
const DEMO_PATIENTS: Record<
  string,
  { dob: string; patientId: string; displayName: string }
> = {
  "demo-token-123": {
    dob: "1976-04-12",
    patientId: "p1",
    displayName: "Your recovery plan",
  },
}

// Values displayed in the login "Demo accounts" helper panel.
export const DEMO_DOCTOR = { email: "rivera@demo.health", password: "demo1234" }
export const DEMO_CAREGIVER = {
  email: "caregiver@demo.health",
  password: "demo1234",
}
export const DEMO_PATIENT_LINK = "/p/demo-token-123"
export const DEMO_PATIENT_DOB = "1976-04-12"

// Generic error message — never echoes the submitted credentials (HIPAA: no
// PHI / credential leakage in error copy or logs).
const GENERIC_AUTH_ERROR = "The information entered doesn't match our records."

// Doctor / caregiver login with email + password.
export function login({
  email,
  password,
}: {
  email: string
  password: string
}): Promise<Session> {
  // TODO: replace with real backend call — POST provider auth. Do not log
  // credentials or PHI. The server should return an opaque session token.
  return new Promise((resolve, reject) => {
    const record = DEMO_CREDENTIALS[email.trim().toLowerCase()]
    if (!record || record.password !== password) {
      reject(new Error(GENERIC_AUTH_ERROR))
      return
    }
    resolve({ ...record.session, exp: Date.now() + IDLE_TIMEOUT_MS })
  })
}

// Patient entry: no password. Validate an opaque token + confirm date of
// birth. The token is the only identifier that may appear in a URL.
export function resolvePatientToken(
  token: string,
  dob: string,
): Promise<Session> {
  // TODO: replace with real backend call — GET /p/:token. The DOB confirm is
  // a second factor; the real endpoint validates both server-side.
  return new Promise((resolve, reject) => {
    const record = DEMO_PATIENTS[token.trim()]
    if (!record || record.dob !== dob.trim()) {
      reject(new Error(GENERIC_AUTH_ERROR))
      return
    }
    resolve({
      role: "patient",
      displayName: record.displayName,
      subtitle: "Patient",
      patientId: record.patientId,
      patientToken: token.trim(),
      exp: Date.now() + IDLE_TIMEOUT_MS,
    })
  })
}

// Extract an opaque token from a pasted "/p/<token>" link or a bare token.
export function parsePatientLink(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/p\/([^/?#\s]+)/)
  return match ? match[1] : trimmed
}

// TODO: replace with real backend call — POST /ingest is the provider-side
// seam that turns a composed/dictated/uploaded summary into stored discharge
// content. Wired from the doctor dashboard's "Send writeup" action later.

export function logout(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY)
  } catch {
    // storage may be unavailable (private mode); nothing persisted anyway.
  }
}

// We persist to sessionStorage (NOT localStorage) and store ONLY a minimal,
// non-PHI marker: role, opaque id, a provider/caregiver display label, and an
// expiry. sessionStorage clears when the tab closes, which better matches a
// clinical session than localStorage. No DOB, email, MRN, diagnoses, or any
// clinical data is ever written to storage.
export function persistSession(session: Session): void {
  try {
    const marker = {
      role: session.role,
      displayName: session.displayName,
      subtitle: session.subtitle,
      caregiverPatientIds: session.caregiverPatientIds,
      patientId: session.patientId,
      patientToken: session.patientToken,
      exp: session.exp,
    }
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(marker))
  } catch {
    // Non-fatal: session simply won't survive a reload.
  }
}

export function restoreSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Session
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}
