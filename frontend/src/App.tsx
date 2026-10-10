import { useEffect, useState, type ReactNode } from "react"
import { useTranscribeMedical } from "./useTranscribeMedical"
import { extractPdfText } from "./extractPdfText"

type IconName = "bell" | "chevron" | "clock" | "document" | "download" | "microphone" | "patients" | "pdf" | "search" | "send" | "stop" | "upload"

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
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="3" y2="15" />
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
  pdf: (
    <>
      <path d="M6 3h9l3 3v15H6z" />
      <path d="M9 13h2c1 0 2-.9 2-2s-1-2-2-2H9v6M15 9h2M15 12h2" />
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
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </>
  ),
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        {iconPaths[name]}
      </g>
    </svg>
  )
}

function NavItem({ icon, label, active = false }: { icon: IconName; label: string; active?: boolean }) {
  return (
    <button className={`nav-item ${active ? "nav-item-active" : ""}`} type="button">
      <Icon name={icon} size={19} />
      <span>{label}</span>
    </button>
  )
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function App() {
  const [mode, setMode] = useState<"write" | "dictate" | "pdf">("write")
  const [note, setNote] = useState("")
  const [seconds, setSeconds] = useState(0)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfDragging, setPdfDragging] = useState(false)
  const [pdfText, setPdfText] = useState<string>("")
  const [pdfStatus, setPdfStatus] = useState<"idle" | "extracting" | "done" | "scanned" | "error">("idle")
  const [pdfMessage, setPdfMessage] = useState<string>("")

  const { transcript, isRecording, error, start, stop } = useTranscribeMedical()

  // Timer driven by real isRecording state
  useEffect(() => {
    if (!isRecording) { setSeconds(0); return }
    const timer = window.setInterval(() => setSeconds((v) => v + 1), 1000)
    return () => window.clearInterval(timer)
  }, [isRecording])

  const formattedTime = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`

  // Active text for the current mode
  const activeText =
    mode === "write" ? note :
    mode === "dictate" ? transcript :
    pdfText

  const handlePdfFile = async (file: File) => {
    setPdfFile(file)
    setPdfText("")
    setPdfStatus("extracting")
    setPdfMessage("")
    const result = await extractPdfText(file)
    if (result.ok) {
      setPdfText(result.text)
      setPdfStatus("done")
      setPdfMessage(`${result.pages} page${result.pages !== 1 ? "s" : ""} extracted`)
    } else if (result.reason === "scanned") {
      setPdfStatus("scanned")
      setPdfMessage(result.message)
    } else {
      setPdfStatus("error")
      setPdfMessage(result.message)
    }
  }

  const handleDownload = () => {
    if (!activeText) return
    downloadText(activeText, "visit-writeup.txt")
  }

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
                <div className="segmented-control" role="tablist" aria-label="Summary input method">
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
                <span className="autosave">Autosaves securely</span>
              </div>

              {mode === "write" ? (
                <div className="write-panel">
                  <label htmlFor="visit-summary">Visit writeup</label>
                  <textarea
                    id="visit-summary"
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Write a clear summary of the visit, key findings, care instructions, and next steps..."
                    value={note}
                  />
                  <div className="editor-footer">
                    <span>{note.length} characters</span>
                    <span>Last edit just now</span>
                  </div>
                </div>
              ) : mode === "dictate" ? (
                <div className={`dictation-panel ${isRecording ? "is-recording" : ""}`}>
                  <div className="waveform" aria-hidden="true">
                    {[18, 30, 22, 44, 58, 34, 50, 26, 62, 38, 54, 30, 46, 22, 34, 18].map((height, i) => (
                      <span key={i} style={{ height }} />
                    ))}
                  </div>

                  <p className="recording-label">
                    {isRecording ? "Listening�" : "Ready to dictate"}
                  </p>

                  {/* Live transcript */}
                  {(isRecording || transcript) && (
                    <div className="live-transcript" aria-live="polite" aria-label="Live transcript">
                      {transcript || <span className="transcript-placeholder">Waiting for speech�</span>}
                    </div>
                  )}

                  {!isRecording && !transcript && (
                    <p className="recording-help">
                      Use your natural speaking voice. The transcript appears live as you speak.
                    </p>
                  )}

                  {error && <p className="transcript-error">{error}</p>}

                  <button
                    aria-label={isRecording ? "Stop dictation" : "Start dictation"}
                    className="record-button"
                    onClick={isRecording ? stop : start}
                    type="button"
                  >
                    <span className="record-icon">
                      <Icon name={isRecording ? "stop" : "microphone"} size={22} />
                    </span>
                    <span>{isRecording ? "Stop dictation" : "Start dictation"}</span>
                  </button>

                  <span className="recording-time">
                    {isRecording ? formattedTime : "Microphone access required"}
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
                    if (file?.type === "application/pdf") handlePdfFile(file)
                  }}
                >
                  {pdfFile ? (
                    <div className="pdf-file-section">
                      <div className="pdf-selected">
                        <div className="pdf-icon-wrap"><Icon name="pdf" size={28} /></div>
                        <div className="pdf-file-info">
                          <strong>{pdfFile.name}</strong>
                          <span>{(pdfFile.size / 1024).toFixed(1)} KB
                            {pdfStatus === "done" && ` · ${pdfMessage}`}
                          </span>
                        </div>
                        <button
                          aria-label="Remove PDF"
                          className="pdf-remove"
                          onClick={() => {
                            setPdfFile(null)
                            setPdfText("")
                            setPdfStatus("idle")
                            setPdfMessage("")
                          }}
                          type="button"
                        >✕</button>
                      </div>

                      {pdfStatus === "extracting" && (
                        <p className="pdf-status extracting">Extracting text…</p>
                      )}
                      {pdfStatus === "scanned" && (
                        <p className="pdf-status scanned">⚠ {pdfMessage}</p>
                      )}
                      {pdfStatus === "error" && (
                        <p className="pdf-status error">✕ {pdfMessage}</p>
                      )}
                      {pdfStatus === "done" && pdfText && (
                        <div className="pdf-preview">
                          <label>Extracted text</label>
                          <textarea readOnly value={pdfText} aria-label="Extracted PDF text" />
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="pdf-upload-icon"><Icon name="upload" size={26} /></div>
                      <p className="pdf-upload-label">Drop a PDF here</p>
                      <p className="pdf-upload-help">
                        Or click below to browse. We'll extract the relevant visit information automatically.
                      </p>
                      <label className="pdf-browse-button">
                        Browse file
                        <input
                          accept="application/pdf"
                          aria-label="Upload PDF"
                          hidden
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfFile(f) }}
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
                  className="secondary-button"
                  disabled={!activeText}
                  onClick={handleDownload}
                  type="button"
                >
                  <Icon name="download" size={16} />
                  Download .txt
                </button>
                <button className="primary-button" type="button">
                  <Icon name="send" size={16} />
                  Send writeup
                </button>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  )
}
