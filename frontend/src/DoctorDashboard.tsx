import { useEffect, useState } from "react"
import { Icon, BrandMark } from "./ui"
import { type Session } from "./auth"

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

type Stat = {
  label: string
  value: string
  hint: string
  highlight?: boolean
}

const stats: Stat[] = [
  { label: "Pending discharges", value: "7", hint: "+2 since yesterday" },
  { label: "Drafts in review", value: "4", hint: "2 awaiting sign-off" },
  {
    label: "Sent today",
    value: "12",
    hint: "+18% vs. avg",
    highlight: true,
  },
  { label: "Avg. completion time", value: "6m", hint: "-1m this week" },
]

type ChecklistItem = {
  id: string
  label: string
  done: boolean
}

const initialChecklist: ChecklistItem[] = [
  { id: "c1", label: "Medication reconciliation", done: true },
  { id: "c2", label: "Follow-up appointment scheduled", done: true },
  { id: "c3", label: "Patient education provided", done: true },
  { id: "c4", label: "Prescriptions sent", done: false },
  { id: "c5", label: "Transportation arranged", done: false },
]

type TeamMember = {
  initials: string
  name: string
  role: string
}

const careTeam: TeamMember[] = [
  { initials: "AR", name: "Dr. A. Rivera", role: "Attending" },
  { initials: "KO", name: "Nurse K. Osei", role: "RN" },
  { initials: "MD", name: "M. Delgado", role: "Pharmacist" },
]

type ActivityEntry = {
  description: string
  time: string
}

const activity: ActivityEntry[] = [
  { description: "Draft saved", time: "2m ago" },
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

// Build avatar initials from a display name (e.g. "Dr. A. Rivera" -> "AR").
function initialsFrom(name: string) {
  const words = name.replace(/^dr\.?\s+/i, "").split(/\s+/).filter(Boolean)
  const letters = words.map((w) => w[0]).join("")
  return (letters.slice(0, 2) || "DR").toUpperCase()
}

export function DoctorDashboard({
  session,
  onLogout,
}: {
  session: Session
  onLogout: () => void
}) {
  const [mode, setMode] = useState<"write" | "dictate" | "pdf">("write")
  const [note, setNote] = useState("")
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [saved, setSaved] = useState(false)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfDragging, setPdfDragging] = useState(false)
  const [selectedPatientId, setSelectedPatientId] = useState(patients[0].id)
  const [checklist, setChecklist] = useState<ChecklistItem[]>(initialChecklist)

  const selectedPatient =
    patients.find((patient) => patient.id === selectedPatientId) ?? patients[0]

  const completedCount = checklist.filter((item) => item.done).length
  const checklistProgress = Math.round(
    (completedCount / checklist.length) * 100,
  )

  const toggleChecklistItem = (id: string) => {
    setChecklist((items) =>
      items.map((item) =>
        item.id === id ? { ...item, done: !item.done } : item,
      ),
    )
  }

  useEffect(() => {
    if (!recording) return
    const timer = window.setInterval(
      () => setSeconds((value) => value + 1),
      1000,
    )
    return () => window.clearInterval(timer)
  }, [recording])

  const toggleRecording = () => {
    setRecording((value) => !value)
    setSaved(false)
  }

  const formattedTime = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`

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
                onSelect={() => setSelectedPatientId(patient.id)}
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
          <button
            className="logout-button"
            onClick={onLogout}
            type="button"
          >
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
          <button
            aria-label="Notifications"
            className="icon-button"
            type="button"
          >
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
                Summarize the visit and send clear next steps to the right
                people.
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
                  <span className="patient-tag" key={tag}>
                    {tag}
                  </span>
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
                <div
                  className="segmented-control"
                  role="tablist"
                  aria-label="Summary input method"
                >
                  <button
                    aria-selected={mode === "write"}
                    className={mode === "write" ? "segment-active" : ""}
                    onClick={() => setMode("write")}
                    role="tab"
                    type="button"
                  >
                    <Icon name="document" size={17} />
                    Write
                  </button>
                  <button
                    aria-selected={mode === "dictate"}
                    className={mode === "dictate" ? "segment-active" : ""}
                    onClick={() => setMode("dictate")}
                    role="tab"
                    type="button"
                  >
                    <Icon name="microphone" size={17} />
                    Dictate
                  </button>
                  <button
                    aria-selected={mode === "pdf"}
                    className={mode === "pdf" ? "segment-active" : ""}
                    onClick={() => setMode("pdf")}
                    role="tab"
                    type="button"
                  >
                    <Icon name="pdf" size={17} />
                    PDF
                  </button>
                </div>
                <span className="autosave">
                  {saved ? "Writeup sent" : "Autosaves securely"}
                </span>
              </div>

              {mode === "write" ? (
                <div className="write-panel">
                  <label htmlFor="visit-summary">Visit writeup</label>
                  <textarea
                    id="visit-summary"
                    onChange={(event) => {
                      setNote(event.target.value)
                      setSaved(false)
                    }}
                    placeholder="Write a clear summary of the visit, key findings, care instructions, and next steps..."
                    value={note}
                  />
                  <div className="editor-footer">
                    <span>{note.length} characters</span>
                    <span>Last edit just now</span>
                  </div>
                </div>
              ) : mode === "dictate" ? (
                <div
                  className={`dictation-panel ${
                    recording ? "is-recording" : ""
                  }`}
                >
                  <div className="waveform" aria-hidden="true">
                    {[
                      18, 30, 22, 44, 58, 34, 50, 26, 62, 38, 54, 30, 46, 22,
                      34, 18,
                    ].map((height, index) => (
                      <span key={index} style={{ height }} />
                    ))}
                  </div>
                  <p className="recording-label">
                    {recording ? "Listening…" : "Ready to dictate"}
                  </p>
                  <p className="recording-help">
                    {recording
                      ? "Speak naturally. Your transcript will appear here when you finish."
                      : "Use your natural speaking voice. You can review and edit the transcript before saving."}
                  </p>
                  <button
                    aria-label={
                      recording ? "Stop dictation" : "Start dictation"
                    }
                    className="record-button"
                    onClick={toggleRecording}
                    type="button"
                  >
                    <span className="record-icon">
                      <Icon
                        name={recording ? "stop" : "microphone"}
                        size={22}
                      />
                    </span>
                    <span>
                      {recording ? "Stop dictation" : "Start dictation"}
                    </span>
                  </button>
                  <span className="recording-time">
                    {recording ? formattedTime : "Microphone access required"}
                  </span>
                </div>
              ) : (
                <div
                  className={`pdf-panel ${pdfDragging ? "pdf-dragging" : ""}`}
                  onDragEnter={(e) => { e.preventDefault(); setPdfDragging(true) }}
                  onDragLeave={(e) => { e.preventDefault(); setPdfDragging(false) }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    setPdfDragging(false)
                    const file = e.dataTransfer.files[0]
                    if (file?.type === "application/pdf") {
                      setPdfFile(file)
                      setSaved(false)
                    }
                  }}
                >
                  {pdfFile ? (
                    <div className="pdf-selected">
                      <div className="pdf-icon-wrap">
                        <Icon name="pdf" size={28} />
                      </div>
                      <div className="pdf-file-info">
                        <strong>{pdfFile.name}</strong>
                        <span>{(pdfFile.size / 1024).toFixed(1)} KB</span>
                      </div>
                      <button
                        aria-label="Remove PDF"
                        className="pdf-remove"
                        onClick={() => setPdfFile(null)}
                        type="button"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="pdf-upload-icon">
                        <Icon name="upload" size={26} />
                      </div>
                      <p className="pdf-upload-label">Drop a PDF here</p>
                      <p className="pdf-upload-help">
                        Or click below to browse. We'll extract the relevant
                        visit information automatically.
                      </p>
                      <label className="pdf-browse-button">
                        Browse file
                        <input
                          accept="application/pdf"
                          aria-label="Upload PDF"
                          hidden
                          onChange={(e) => {
                            const file = e.target.files?.[0]
                            if (file) {
                              setPdfFile(file)
                              setSaved(false)
                            }
                          }}
                          type="file"
                        />
                      </label>
                    </>
                  )}
                </div>
              )}

              <div className="composer-actions">
                <button className="tertiary-button" type="button">
                  Save as draft
                </button>
                <button
                  className="primary-button"
                  onClick={() => setSaved(true)}
                  type="button"
                >
                  <Icon name="send" size={16} />
                  {saved ? "Sent" : "Send writeup"}
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
                        className={`checklist-item ${item.done ? "is-done" : ""}`}
                        onClick={() => toggleChecklistItem(item.id)}
                        type="button"
                        aria-pressed={item.done}
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
                <div className="side-card-head">
                  <h3>Care team</h3>
                </div>
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
                <div className="side-card-head">
                  <h3>Recent activity</h3>
                </div>
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
