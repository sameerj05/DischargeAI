import { useState } from "react"
import {
  restoreSession,
  persistSession,
  logout,
  IDLE_TIMEOUT_MS,
  type Session,
} from "./auth"
import { useIdleTimeout } from "./useIdleTimeout"
import { Login } from "./Login"
import { DoctorDashboard } from "./DoctorDashboard"
import { CaregiverView } from "./CaregiverView"
import { PatientView } from "./PatientView"

// Detect a patient access link (/p/<token>) once at module load. The opaque
// token is the ONLY identifier permitted in a URL — no name/DOB/MRN (HIPAA 1).
function readInitialToken(): string | undefined {
  const match = window.location.pathname.match(/^\/p\/(.+)$/)
  return match ? match[1] : undefined
}

const initialToken = readInitialToken()

export default function App() {
  // Restore a non-expired session from sessionStorage (restoreSession already
  // drops expired markers). RBAC (HIPAA 5) is enforced by rendering strictly
  // one view per role below.
  const [session, setSession] = useState<Session | null>(() => restoreSession())
  const [signedOutNotice, setSignedOutNotice] = useState<string | undefined>(
    undefined,
  )

  const handleLogin = (next: Session) => {
    persistSession(next)
    setSignedOutNotice(undefined)
    setSession(next)
  }

  const handleLogout = () => {
    logout()
    setSession(null)
  }

  const handleTimeout = () => {
    logout()
    setSession(null)
    setSignedOutNotice("You were signed out for your security.")
  }

  // Idle/session timeout only runs while authenticated (HIPAA item 3).
  useIdleTimeout(session !== null, IDLE_TIMEOUT_MS, handleTimeout)

  if (!session) {
    return (
      <Login
        initialToken={initialToken}
        notice={signedOutNotice}
        onLogin={handleLogin}
      />
    )
  }

  // Role-based rendering: each role reaches only its own view.
  if (session.role === "doctor") {
    return <DoctorDashboard onLogout={handleLogout} session={session} />
  }
  if (session.role === "caregiver") {
    return <CaregiverView onLogout={handleLogout} session={session} />
  }
  return <PatientView onLogout={handleLogout} session={session} />
}
