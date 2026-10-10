import { useEffect, useState, type ReactNode } from "react"

type IconName = "bell" | "chevron" | "clock" | "document" | "microphone" | "patients" | "search" | "send" | "stop"

const iconPaths: Record<IconName, ReactNode> = {
  bell: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </>
  ),
  chevron: <path d="m9 18 6-6-6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 9h6M9 13h6M9 17h4" />
    </>
  ),
  microphone: (
    <>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </>
  ),
  patients: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-4 2-7 6-7s6 3 6 7M16 5a3 3 0 0 1 0 6M17 14c2.5.6 4 2.6 4 6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  send: (
    <>
      <path d="m21 3-7.2 18-3.9-7.9L2 9.2 21 3Z" />
      <path d="m9.9 13.1 4.4-4.4" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
}

function Icon({ name, size = 20 }: { name: IconName size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      >
        {iconPaths[name]}
      </g>
    </svg>
  )
}

function NavItem({
  icon,
  label,
  active = false,
}: {
  icon: IconName
  label: string
  active?: boolean
}) {
  return (
    <button
      className={`nav-item ${active ? "nav-item-active" : ""}`}
      type="button"
    >
      <Icon name={icon} size={19} />
      <span>{label}</span>
    </button>
  )
}

export default function App() {
  const [mode, setMode] = useState<"write" | "dictate">("write")
  const [note, setNote] = useState("")
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [saved, setSaved] = useState(false)

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
              <span />
              <span />
            </div>
            <span>Notely</span>
          </div>

          <nav aria-label="Main navigation" className="main-nav">
            <NavItem icon="patients" label="Patients" />
          </nav>
        </div>

        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">AR</div>
            <div className="profile-copy">
              <strong>Dr. A. Rivera</strong>
              <span>Internal Medicine</span>
            </div>
            <Icon name="chevron" size={16} />
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand">Notely</div>
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

          <section className="patient-card" aria-label="Selected patient">
            <div className="patient-avatar">EM</div>
            <div className="patient-info">
              <div className="patient-name-row">
                <h2>Elena Martinez</h2>
                <span className="status-pill">In progress</span>
              </div>
              <div className="patient-meta">
                <span>48 years</span>
                <i />
                <span>MRN 034821</span>
                <i />
                <span>Follow-up visit</span>
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
              ) : (
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
          </div>
        </div>
      </main>
    </div>
  )
}
