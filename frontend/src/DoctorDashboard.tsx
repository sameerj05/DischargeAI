import { useEffect, useRef, useState } from "react"
import { Icon, BrandMark } from "./ui"
import { type Session } from "./auth"
import { useTranscribeMedical } from "./useTranscribeMedical"
import { extractPdfText } from "./extractPdfText"
import { postIngest } from "./api"

type Patient = {
  id: string
  name: string
  initials: string
  age: number
  mrn: string
  visit: string
  status: string
  physician: string
  admittedDate: string
  tags: string[]
}

const patients: Patient[] = [
  {
    id: "p1",
    name: "Elena Martinez",
    initials: "EM",
    age: 48,
    mrn: "034821",
    visit: "Follow-up visit",
    status: "In progress",
    physician: "Dr. A. Rivera",
    admittedDate: "Admitted Mar 2",
    tags: ["Hypertension", "Post-op day 3"],
  },
  {
    id: "p2",
    name: "James Carter",
    initials: "JC",
    age: 63,
    mrn: "029145",
    visit: "Post-op discharge",
    status: "Ready",
    physician: "Dr. L. Okafor",
    admittedDate: "Admitted Feb 28",
    tags: ["Knee replacement", "Diabetes"],
  },
  {
    id: "p3",
    name: "Priya Nair",
    initials: "PN",
    age: 35,
    mrn: "041203",
    visit: "New consult",
    status: "Draft",
    physician: "Dr. A. Rivera",
    admittedDate: "Admitted Mar 4",
    tags: ["Asthma", "Pregnancy"],
  },
  {
    id: "p4",
    name: "Robert Chen",
    initials: "RC",
    age: 71,
    mrn: "017880",
    visit: "Medication review",
    status: "Ready",
    physician: "Dr. S. Mehta",
    admittedDate: "Admitted Mar 1",
    tags: ["Atrial fibrillation", "CKD stage 2"],
  },
  {
    id: "p5",
    name: "Aisha Johnson",
    initials: "AJ",
    age: 29,
    mrn: "052674",
    visit: "Follow-up visit",
    status: "Draft",
    physician: "Dr. L. Okafor",
    admittedDate: "Admitted Mar 5",
    tags: ["Migraine", "Anemia"],
  },
]

function statusClass(status: string) {
  if (status === "Ready") return "status-pill status-ready"
  if (status === "In progress") return "status-pill status-progress"
  return "status-pill status-draft"
}

type Stat = { label: string; value: string; hint: string; highlight?: boolean }

const stats: Stat[] = [
  { label: "Pending discharges", value: "7", hint: "+2 since yesterday" },
  { label: "Drafts in review", value: "4", hint: "2 awaiting sign-off" },
  { label: "Sent today", value: "12", hint: "+18% vs. avg", highlight: true },
  { label: "Avg. completion time", value: "6m", hint: "-1m this week" },
]

type ChecklistItem = { id: string; label: string; done: boolean }

const initialChecklist: ChecklistItem[] = [
  { id: "c1", label: "Medication reconciliation", done: true },
  { id: "c2", label: "Follow-up appointment scheduled", done: true },
  { id: "c3", label: "Patient education provided", done: true },
  { id: "c4", label: "Prescriptions sent", done: false },
  { id: "c5", label: "Transportation arranged", done: false },
]

type TeamMember = { initials: string; name: string; role: string }

const careTeam: TeamMember[] = [
  { initials: "AR", name: "Dr. A. Rivera", role: "Attending" },
  { initials: "KO", name: "Nurse K. Osei", role: "RN" },
  { initials: "MD", name: "M. Delgado", role: "Pharmacist" },
]

type ActivityEntry = { description: string; time: string }

const activity: ActivityEntry[] = [
  { description: "PDF uploaded", time: "1h ago" },
  { description: "Note dictated", time: "3h ago" },
  { description: "Patient record opened", time: "5h ago" },
]

function PatientNavItem({
  patient,
  active,
  onSelect,
}: {
  patient: Patient
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      className={`nav-item patient-nav-item ${active ? "nav-item-active" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="nav-patient-avatar">{patient.initials}</span>
      <span className="nav-patient-name">{patient.name}</span>
    </button>
  )
}

function initialsFrom(name: string) {
  const words = name.replace(/^dr\.?\s+/i, "").split(/\s+/).filter(Boolean)
  const letters = words.map((w) => w[0]).join("")
  return (letters.slice(0, 2) || "DR").toUpperCase()
}

// Per-patient note store
type PatientNote = { text: string; inputType: "text" | "pdf" | "dictation" }
const emptyNote = (): PatientNote => ({ text: "", inputType: "text" })

export function DoctorDashboard({
  session,
  onLogout,
}: {
  session: Session
  onLogout: () => void
}) {
  // Map of patientId -> note so switching patients preserves each writeup
  const [notes, setNotes] = useState<Record<string, PatientNote>>({})
  const [selectedPatientId, setSelectedPatientId] = useState(patients[0].id)
  const [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false)
  const [checklist, setChecklist] = useState<ChecklistItem[]>(initialChecklist)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  const { transcript, isRecording, error: transcribeError, start: startRecording, stop: stopRecording } = useTranscribeMedical()

  const currentNote = notes[selectedPatientId] ?? emptyNote()
  const noteText = currentNote.text

  const setNoteText = (text: string, inputType?: PatientNote["inputType"]) => {
    setNotes((prev) => ({
      ...prev,
      [selectedPatientId]: {
        text,
        inputType: inputType ?? prev[selectedPatientId]?.inputType ?? "text",
      },
    }))
  }

  // Switch patient — stop any active recording first
  const handleSelectPatient = (id: string) => {
    if (isRecording) stopRecording()
    setPdfError(null)
    setSelectedPatientId(id)
  }

  // Append confirmed transcript words into the current patient note
  const prevTranscriptRef = useRef("")
  useEffect(() => {
    if (transcript && transcript !== prevTranscriptRef.current) {
      const newWords = transcript.slice(prevTranscriptRef.current.length).trimStart()
      if (newWords) {
        setNotes((prev) => {
          const cur = prev[selectedPatientId] ?? emptyNote()
          return {
            ...prev,
            [selectedPatientId]: {
              text: cur.text ? cur.text + " " + newWords : newWords,
              inputType: "dictation",
            },
          }
        })
      }
      prevTranscriptRef.current = transcript
    }
  }, [transcript, selectedPatientId])

  // Reset transcript ref when patient changes so old words don't bleed in
  useEffect(() => {
    prevTranscriptRef.current = ""
  }, [selectedPatientId])

  const selectedPatient =
    patients.find((p) => p.id === selectedPatientId) ?? patients[0]

  const completedCount = checklist.filter((item) => item.done).length
  const checklistProgress = Math.round((completedCount / checklist.length) * 100)

  const toggleChecklistItem = (id: string) => {
    setChecklist((items) =>
      items.map((item) => (item.id === id ? { ...item, done: !item.done } : item))
    )
  }

  useEffect(() => {
    if (!isRecording) { setSeconds(0); return }
    const timer = window.setInterval(() => setSeconds((v) => v + 1), 1000)
    return () => window.clearInterval(timer)
  }, [isRecording])

  const formattedTime = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`

  // PDF upload — extracts text and inserts it into the unified textarea
  const handlePdfFile = async (file: File) => {
    setPdfError(null)
    setPdfLoading(true)
    const result = await extractPdfText(file)
    setPdfLoading(false)
    if (result.ok) {
      const insert = result.text
      setNotes((prev) => {
        const cur = prev[selectedPatientId] ?? emptyNote()
        const joined = cur.text ? cur.text + "\n\n" + insert : insert
        return { ...prev, [selectedPatientId]: { text: joined, inputType: "pdf" } }
      })
    } else if (result.reason === "scanned") {
      setPdfError(result.message)
    } else {
      setPdfError(result.message)
    }
  }

  const handleDownload = () => {
    if (!noteText) return
    const blob = new Blob([noteText], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `writeup-${selectedPatientId}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleSend = async () => {
    if (!noteText || sending) return
    setSending(true)
    try {
      await postIngest({
        data: noteText,
        type: currentNote.inputType,
        patientId: selectedPatient.id,
      })
    } catch (err) {
      console.error("[ingest] Failed to send:", err)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">
            <div className="brand-mark">
              <BrandMark size={28} />
            </div>
            <span>Discharge AI</span>
          </div>

          <nav aria-label="Patient list" className="main-nav">
            <div className="nav-section-label">
              <Icon name="patients" size={16} />
              <span>Patients</span>
            </div>
            {patients.map((patient) => (
              <PatientNavItem
                active={patient.id === selectedPatientId}
                key={patient.id}
                onSelect={() => handleSelectPatient(patient.id)}
                patient={patient}
              />
            ))}
          </nav>
        </div>

        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">{initialsFrom(session.displayName)}</div>
            <div className="profile-copy">
              <strong>{session.displayName}</strong>
              <span>{session.subtitle}</span>
            </div>
            <Icon name="chevron" size={16} />
          </div>
          <button className="logout-button" onClick={onLogout} type="button">
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand">
            <div className="brand-mark brand-mark-mobile">
              <BrandMark size={24} />
            </div>
            <span>Discharge AI</span>
          </div>
          <label className="search">
            <Icon name="search" size={18} />
            <input aria-label="Search patients" placeholder="Search patients" />
          </label>
          <button aria-label="Notifications" className="icon-button" type="button">
            <Icon name="bell" size={19} />
            <span className="notification-dot" />
          </button>
        </header>

        <div className="workspace">
          <div className="page-heading">
            <div>
              <p className="eyebrow">Patient communication</p>
              <h1>Create visit writeup</h1>
              <p className="heading-support">
                Summarize the visit and send clear next steps to the right people.
              </p>
            </div>
            <button className="secondary-button" type="button">
              <Icon name="clock" size={17} />
              View drafts
            </button>
          </div>

          <section className="stat-row" aria-label="Workspace summary">
            {stats.map((stat) => (
              <div
                className={`stat-card ${stat.highlight ? "stat-card-highlight" : ""}`}
                key={stat.label}
              >
                <span className="stat-value">{stat.value}</span>
                <span className="stat-label">{stat.label}</span>
                <span className="stat-hint">
                  <Icon name="activity" size={13} />
                  {stat.hint}
                </span>
              </div>
            ))}
          </section>

          <section className="patient-card" aria-label="Selected patient">
            <div className="patient-avatar">{selectedPatient.initials}</div>
            <div className="patient-info">
              <div className="patient-name-row">
                <h2>{selectedPatient.name}</h2>
                <span className={statusClass(selectedPatient.status)}>
                  {selectedPatient.status}
                </span>
              </div>
              <div className="patient-meta">
                <span>{selectedPatient.age} years</span>
                <i />
                <span>MRN {selectedPatient.mrn}</span>
                <i />
                <span>{selectedPatient.visit}</span>
              </div>
              <div className="patient-detail-row">
                <span className="patient-detail">
                  <Icon name="stethoscope" size={14} />
                  {selectedPatient.physician}
                </span>
                <span className="patient-detail">
                  <Icon name="calendar" size={14} />
                  {selectedPatient.admittedDate}
                </span>
              </div>
              <div className="patient-tags">
                {selectedPatient.tags.map((tag) => (
                  <span className="patient-tag" key={tag}>{tag}</span>
                ))}
              </div>
            </div>
            <button className="patient-link" type="button">
              View patient
              <Icon name="chevron" size={15} />
            </button>
          </section>

          <div className="content-grid">
            <section className="composer-card">
              <div className="composer-top">
                <span className="composer-title">
                  <Icon name="document" size={16} />
                  Visit writeup
                </span>
                <span className="autosave">
                  {sending ? "Sending…" : "Autosaves securely"}
                </span>
              </div>

              <div className="write-panel">
                <div className="textarea-wrap">
                  <textarea
                    id="visit-summary"
                    aria-label="Visit writeup"
                    className={isRecording ? "is-recording-textarea" : ""}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Write a summary, dictate using the mic, or upload a PDF using the attach button…"
                    value={noteText}
                  />

                  {/* Mic button — top right */}
                  <button
                    aria-label={isRecording ? "Stop dictation" : "Start dictation"}
                    className={`mic-button ${isRecording ? "mic-active" : ""}`}
                    onClick={isRecording ? stopRecording : startRecording}
                    title={isRecording ? "Stop dictation" : "Dictate into note"}
                    type="button"
                  >
                    <Icon name={isRecording ? "stop" : "microphone"} size={22} />
                  </button>

                  {/* PDF upload button — below mic */}
                  <label
                    aria-label="Upload PDF"
                    className={`pdf-attach-button ${pdfLoading ? "pdf-attach-loading" : ""}`}
                    title="Upload a PDF — text will be inserted into the note"
                  >
                    <Icon name={pdfLoading ? "clock" : "upload"} size={18} />
                    <input
                      accept="application/pdf"
                      hidden
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfFile(f) }}
                      type="file"
                    />
                  </label>
                </div>

                {pdfError && <p className="transcript-error">⚠ {pdfError}</p>}
                {transcribeError && <p className="transcript-error">{transcribeError}</p>}

                <div className="editor-footer">
                  <span>{noteText.length} characters</span>
                  <span>
                    {isRecording ? (
                      <span className="recording-indicator">
                        <span className="recording-dot" aria-hidden="true" />
                        Listening… {formattedTime}
                      </span>
                    ) : (
                      "Last edit just now"
                    )}
                  </span>
                </div>
              </div>

              <div className="composer-actions">
                <button
                  className="secondary-button"
                  disabled={!noteText}
                  onClick={handleDownload}
                  type="button"
                >
                  <Icon name="download" size={16} />
                  Download .txt
                </button>
                <button
                  className="primary-button"
                  disabled={sending || !noteText}
                  onClick={handleSend}
                  type="button"
                >
                  <Icon name="send" size={16} />
                  {sending ? "Sent" : "Send writeup"}
                </button>
              </div>
            </section>

            <aside className="side-column" aria-label="Discharge details">
              <section className="side-card checklist-card">
                <div className="side-card-head">
                  <h3>Discharge checklist</h3>
                  <span className="checklist-count">
                    {completedCount} of {checklist.length} complete
                  </span>
                </div>
                <div
                  className="checklist-progress"
                  role="progressbar"
                  aria-valuenow={checklistProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${checklistProgress}%` }} />
                </div>
                <ul className="checklist">
                  {checklist.map((item) => (
                    <li key={item.id}>
                      <button
                        aria-pressed={item.done}
                        className={`checklist-item ${item.done ? "is-done" : ""}`}
                        onClick={() => toggleChecklistItem(item.id)}
                        type="button"
                      >
                        <span className="checklist-box">
                          {item.done ? <Icon name="check" size={14} /> : null}
                        </span>
                        <span className="checklist-label">{item.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="side-card">
                <div className="side-card-head"><h3>Care team</h3></div>
                <ul className="team-list">
                  {careTeam.map((member) => (
                    <li className="team-member" key={member.name}>
                      <span className="team-avatar">{member.initials}</span>
                      <div className="team-copy">
                        <strong>{member.name}</strong>
                        <span>{member.role}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="side-card">
                <div className="side-card-head"><h3>Recent activity</h3></div>
                <ul className="activity-list">
                  {activity.map((entry) => (
                    <li className="activity-item" key={entry.description}>
                      <span className="activity-dot" aria-hidden="true" />
                      <div className="activity-copy">
                        <strong>{entry.description}</strong>
                        <span>{entry.time}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </aside>
          </div>
        </div>
      </main>
    </div>
  )
}
