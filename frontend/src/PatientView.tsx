import { type CSSProperties, useState } from "react"
import { Icon, BrandMark } from "./ui"
import { type Session } from "./auth"
import { useChecklist } from "./checklist"
import {
  mockDischargeByPatient,
  type CheckItem,
  type DischargePlan,
  type Language,
  type MedItem,
} from "./data"
import { t } from "./i18n"
import { LanguagePicker } from "./LanguagePicker"
import { FontSizeControl } from "./FontSizeControl"
import { useFontScale } from "./fontScale"
import { DeletionTimer } from "./DeletionTimer"

// A flag like "NEW" tints Care Teal; anything about duration or a higher dose
// ("for N more days", "higher dose") tints Coral to draw more attention.
function flagTone(flag: string): "new" | "caution" {
  const lower = flag.toLowerCase()
  if (lower.includes("more day") || lower.includes("higher dose")) {
    return "caution"
  }
  return "new"
}

// Progress bar + "N of M complete" header shared by every checklist section.
function ChecklistProgress({
  done,
  total,
  language,
}: {
  done: number
  total: number
  language: Language
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <div className="track-progress">
      <span className="track-progress-count">
        {t(language, "progressComplete", { done, total })}
      </span>
      <div className="checklist-progress" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// A single big-tap-target checkbox row for a trackable item.
function CheckRow({
  id,
  label,
  detail,
  checked,
  onToggle,
}: {
  id: string
  label: string
  detail?: string
  checked: boolean
  onToggle: (id: string) => void
}) {
  return (
    <li>
      <button
        aria-pressed={checked}
        className={`track-item ${checked ? "is-done" : ""}`}
        onClick={() => onToggle(id)}
        type="button"
      >
        <span className="track-box">
          {checked ? <Icon name="check" size={18} /> : null}
        </span>
        <span className="track-copy">
          <span className="track-label">{label}</span>
          {detail ? <span className="track-detail">{detail}</span> : null}
        </span>
      </button>
    </li>
  )
}

export function PatientView({
  session,
  onLogout,
}: {
  session: Session
  onLogout: () => void
}) {
  const [language, setLanguage] = useState<Language>("en")
  const { step, scale, setFontStep, decrease, increase } = useFontScale()

  // TODO: replace with real backend call — GET /p/:token returns the
  // discharge plan keyed by language (plus expiresAt) for the patient.
  const record = session.patientId
    ? mockDischargeByPatient[session.patientId]
    : undefined
  const plan = record?.byLang[language]
  const isRtl = language === "ar"

  const { isChecked, toggle, progressFor } = useChecklist(session.patientId)

  return (
    <div className="role-shell patient-shell">
      <header className="role-header">
        <div className="role-header-brand">
          <div className="brand-mark">
            <BrandMark size={26} />
          </div>
          <span>Discharge AI</span>
        </div>
        <button className="logout-button" onClick={onLogout} type="button">
          <Icon name="logout" size={18} />
          {t(language, "signOut")}
        </button>
      </header>

      <main
        className="patient-main"
        dir={isRtl ? "rtl" : "ltr"}
        style={{ "--patient-font-scale": scale } as CSSProperties}
      >
        <div className="patient-intro">
          <h1>{plan ? plan.title : session.displayName}</h1>
          <p className="patient-lede">{t(language, "patientLede")}</p>

          {record ? (
            <DeletionTimer createdAt={record.createdAt} language={language} />
          ) : null}

          <div className="patient-controls">
            <LanguagePicker language={language} onChange={setLanguage} />
            <FontSizeControl
              language={language}
              step={step}
              onStep={setFontStep}
              onDecrease={decrease}
              onIncrease={increase}
            />
          </div>
        </div>

        {!plan ? (
          <section className="patient-section" aria-live="polite">
            <p>{t(language, "planUnavailable")}</p>
          </section>
        ) : (
          <PatientPlan
            plan={plan}
            language={language}
            isChecked={isChecked}
            onToggle={toggle}
            progressFor={progressFor}
          />
        )}

        <p className="privacy-notice">
          <Icon name="lock" size={14} />
          {t(language, "privacyNotice")}
        </p>
      </main>
    </div>
  )
}

function PatientPlan({
  plan,
  language,
  isChecked,
  onToggle,
  progressFor,
}: {
  plan: DischargePlan
  language: Language
  isChecked: (id: string) => boolean
  onToggle: (id: string) => void
  progressFor: (ids: string[]) => { done: number; total: number }
}) {
  // Progress across every trackable medication dose item (checkbox meds only).
  const medIds = plan.medications.groups
    .flatMap((g) => g.items)
    .filter((m) => m.trackable)
    .map((m) => m.id)
  const medProgress = progressFor(medIds)

  return (
    <>
      <section className="patient-section" aria-labelledby="meds-head">
        <div className="patient-section-head">
          <h2 id="meds-head" className="patient-section-title">
            <Icon name="pill" size={22} /> {t(language, "medicationsTitle")}
          </h2>
        </div>
        <p className="patient-section-intro">{plan.medications.intro}</p>

        {plan.medications.groups.map((grp) => (
          <div className="med-group" key={grp.key}>
            <h3 className="med-group-label">{grp.label}</h3>
            {grp.key === "asNeeded" ? (
              <ul className="med-plain-list">
                {grp.items.map((med) => (
                  <li className="med-plain" key={med.id}>
                    <MedCopy med={med} />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="track-list">
                {grp.items.map((med) => (
                  <li key={med.id}>
                    <button
                      aria-pressed={isChecked(med.id)}
                      className={`track-item ${
                        isChecked(med.id) ? "is-done" : ""
                      }`}
                      onClick={() => onToggle(med.id)}
                      type="button"
                    >
                      <span className="track-box">
                        {isChecked(med.id) ? (
                          <Icon name="check" size={18} />
                        ) : null}
                      </span>
                      <span className="track-copy">
                        <MedCopy med={med} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>

      {plan.newMedicines.length > 0 ? (
        <section className="patient-section" aria-labelledby="new-meds-head">
          <h2 id="new-meds-head" className="patient-section-title">
            <Icon name="pill" size={22} /> {t(language, "newMedicinesTitle")}
          </h2>
          <ul className="explainer-list">
            {plan.newMedicines.map((item) => (
              <li className="explainer-card" key={item.name}>
                <strong>{item.name}</strong>
                <span>{item.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.stoppedMedicines.length > 0 ? (
        <section className="patient-section" aria-labelledby="stopped-meds-head">
          <h2 id="stopped-meds-head" className="patient-section-title">
            <Icon name="stop" size={22} /> {t(language, "stoppedMedicinesTitle")}
          </h2>
          <ul className="stopped-list">
            {plan.stoppedMedicines.map((item) => (
              <li className="stopped-item" key={item.name}>
                <span className="stopped-icon" aria-hidden="true">
                  <Icon name="stop" size={18} />
                </span>
                <span className="stopped-copy">
                  <strong>{item.name}</strong>
                  <span>{item.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="patient-section" aria-labelledby="todos-head">
        <h2 id="todos-head" className="patient-section-title">
          <Icon name="check" size={22} /> {t(language, "todosTitle")}
        </h2>

        <TodoChecklist
          icon="activity"
          title={t(language, "labsTitle")}
          items={plan.todos.labs}
          emptyLine={t(language, "labsEmpty")}
          language={language}
          isChecked={isChecked}
          onToggle={onToggle}
          progressFor={progressFor}
        />

        <TodoChecklist
          icon="calendar"
          title={t(language, "appointmentsTitle")}
          items={plan.todos.appointments}
          note={plan.todos.appointmentsNote}
          language={language}
          isChecked={isChecked}
          onToggle={onToggle}
          progressFor={progressFor}
        />

        <TodoChecklist
          icon="document"
          title={t(language, "careInstructionsTitle")}
          items={plan.todos.careInstructions}
          language={language}
          isChecked={isChecked}
          onToggle={onToggle}
          progressFor={progressFor}
        />
      </section>

      {plan.generalInstructions.length > 0 ? (
        <section className="patient-section" aria-labelledby="general-head">
          <h2 id="general-head" className="patient-section-title">
            <Icon name="document" size={22} />{" "}
            {t(language, "generalInstructionsTitle")}
          </h2>
          <ul className="general-list">
            {plan.generalInstructions.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className="patient-section warning-signs"
        role="alert"
        aria-labelledby="warning-head"
      >
        <h2 id="warning-head" className="warning-signs-title">
          <Icon name="warning" size={26} /> {plan.warningSigns.heading}
        </h2>
        <ul className="warning-signs-list">
          {plan.warningSigns.signs.map((sign, index) => (
            <li key={index}>{sign}</li>
          ))}
        </ul>
        <p className="warning-signs-emergency">
          <Icon name="warning" size={20} /> {plan.warningSigns.emergencyLine}
        </p>
      </section>

      {plan.whyHospitalized.length > 0 ? (
        <section className="patient-section" aria-labelledby="why-head">
          <h2 id="why-head" className="patient-section-title">
            <Icon name="stethoscope" size={22} />{" "}
            {t(language, "whyHospitalizedTitle")}
          </h2>
          <ul className="general-list">
            {plan.whyHospitalized.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

// hideNewFlag defaults true — NEW is always redundant here since the
// New Medicines section already lists every new drug.
function MedCopy({ med, hideNewFlag = true }: { med: MedItem; hideNewFlag?: boolean }) {
  const isNewFlag = med.flag?.toUpperCase().startsWith("NEW")
  const showFlag = med.flag && !(hideNewFlag && isNewFlag)
  return (
    <span className="med-text">
      <span className="med-name-row">
        <strong className="med-name">{med.name}</strong>
        {showFlag ? (
          <span className={`med-flag med-flag-${flagTone(med.flag!)}`}>
            {med.flag}
          </span>
        ) : null}
      </span>
      <span className="med-reason">{med.reason}</span>
    </span>
  )
}

function TodoChecklist({
  icon,
  title,
  items,
  emptyLine,
  note,
  language,
  isChecked,
  onToggle,
  progressFor,
}: {
  icon: "activity" | "calendar" | "document"
  title: string
  items: CheckItem[]
  emptyLine?: string
  note?: string
  language: Language
  isChecked: (id: string) => boolean
  onToggle: (id: string) => void
  progressFor: (ids: string[]) => { done: number; total: number }
}) {
  const progress = progressFor(items.map((i) => i.id))
  return (
    <div className="todo-group">
      <div className="todo-group-head">
        <h3 className="todo-group-title">
          <Icon name={icon} size={18} /> {title}
        </h3>
        {items.length > 0 ? (
          <ChecklistProgress
            done={progress.done}
            total={progress.total}
            language={language}
          />
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="todo-empty">{emptyLine}</p>
      ) : (
        <ul className="track-list">
          {items.map((item) => (
            <CheckRow
              key={item.id}
              id={item.id}
              label={item.label}
              detail={item.detail}
              checked={isChecked(item.id)}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
      {note ? <p className="todo-note">{note}</p> : null}
    </div>
  )
}
