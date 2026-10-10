import { useState, type FormEvent } from "react"
import { Icon, BrandMark } from "./ui"
import {
  login,
  resolvePatientToken,
  parsePatientLink,
  type Role,
  type Session,
  DEMO_DOCTOR,
  DEMO_CAREGIVER,
  DEMO_PATIENT_LINK,
  DEMO_PATIENT_DOB,
} from "./auth"

const ROLE_TABS: { role: Role; label: string }[] = [
  { role: "doctor", label: "Doctor" },
  { role: "caregiver", label: "Caregiver" },
  { role: "patient", label: "Patient" },
]

export function Login({
  onLogin,
  initialToken,
  notice,
}: {
  onLogin: (session: Session) => void
  initialToken?: string
  notice?: string
}) {
  // When arriving via a /p/<token> link, preselect the patient role.
  const [role, setRole] = useState<Role>(initialToken ? "patient" : "doctor")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [accessLink, setAccessLink] = useState(
    initialToken ? `/p/${initialToken}` : "",
  )
  const [dob, setDob] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const selectRole = (next: Role) => {
    setRole(next)
    setError(null)
  }

  // Keyboard operability for the tablist (left/right arrows).
  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
    event.preventDefault()
    const dir = event.key === "ArrowRight" ? 1 : -1
    const next = (index + dir + ROLE_TABS.length) % ROLE_TABS.length
    selectRole(ROLE_TABS[next].role)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      if (role === "patient") {
        const token = parsePatientLink(accessLink)
        const session = await resolvePatientToken(token, dob)
        onLogin(session)
      } else {
        const session = await login({ email, password })
        // Guard: a doctor-tab submit must not open a caregiver session, etc.
        if (session.role !== role) {
          throw new Error("The information entered doesn't match our records.")
        }
        onLogin(session)
      }
    } catch (err) {
      // Never echo credentials or PHI — surface a generic message only.
      setError(
        err instanceof Error
          ? err.message
          : "The information entered doesn't match our records.",
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <main className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <div className="brand-mark">
            <BrandMark size={30} />
          </div>
          <span>Discharge AI</span>
        </div>

        <h1 id="login-title" className="login-title">
          Sign in
        </h1>
        <p className="login-subtitle">
          Choose how you're signing in to continue to your care information.
        </p>

        {notice ? (
          <p className="auth-notice" role="status">
            <Icon name="clock" size={16} />
            {notice}
          </p>
        ) : null}

        <div
          className="segmented-control login-roles"
          role="tablist"
          aria-label="Sign-in role"
        >
          {ROLE_TABS.map((tab, index) => (
            <button
              aria-selected={role === tab.role}
              className={role === tab.role ? "segment-active" : ""}
              id={`role-tab-${tab.role}`}
              key={tab.role}
              onClick={() => selectRole(tab.role)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              role="tab"
              tabIndex={role === tab.role ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          {role === "patient" ? (
            <>
              <div className="field">
                <label htmlFor="access-link">Access link or code</label>
                <input
                  autoComplete="off"
                  id="access-link"
                  inputMode="text"
                  onChange={(e) => setAccessLink(e.target.value)}
                  placeholder="Paste the link from your care team"
                  type="text"
                  value={accessLink}
                />
              </div>
              <div className="field">
                <label htmlFor="dob">Confirm your date of birth</label>
                <input
                  autoComplete="off"
                  id="dob"
                  onChange={(e) => setDob(e.target.value)}
                  type="date"
                  value={dob}
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  autoComplete="username"
                  id="email"
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@organization.health"
                  type="email"
                  value={email}
                />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  autoComplete="current-password"
                  id="password"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  type="password"
                  value={password}
                />
              </div>
            </>
          )}

          {error ? (
            <p className="inline-error" role="alert">
              <Icon name="warning" size={16} />
              {error}
            </p>
          ) : null}

          <button
            className="primary-button login-submit"
            disabled={busy}
            type="submit"
          >
            <Icon name="lock" size={16} />
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>

        <p className="privacy-notice">
          <Icon name="lock" size={14} />
          Protected health information. Authorized access only.
        </p>

        <section className="demo-panel" aria-label="Demo accounts">
          <h2 className="demo-title">Demo accounts</h2>
          <p className="demo-hint">
            For evaluation only. Use these to explore each role.
          </p>
          <dl className="demo-list">
            <div className="demo-row">
              <dt>Doctor</dt>
              <dd>
                {DEMO_DOCTOR.email} · {DEMO_DOCTOR.password}
              </dd>
            </div>
            <div className="demo-row">
              <dt>Caregiver</dt>
              <dd>
                {DEMO_CAREGIVER.email} · {DEMO_CAREGIVER.password}
              </dd>
            </div>
            <div className="demo-row">
              <dt>Patient</dt>
              <dd>
                {DEMO_PATIENT_LINK} · DOB {DEMO_PATIENT_DOB}
              </dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  )
}
