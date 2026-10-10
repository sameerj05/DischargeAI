import { Icon, BrandMark } from "./ui"
import { type Session } from "./auth"
import { useChecklist } from "./checklist"
import {
  mockDischargeByPatient,
  type CheckItem,
  type DischargePlan,
  type MedItem,
} from "./data"
import { t } from "./i18n"
import { DeletionTimer } from "./DeletionTimer"

// Caregiver chrome renders in English (the task explicitly allows defaulting
// the caregiver view to en, as long as nothing is half-translated). Routing
// labels through t("en", ...) keeps a single source of truth with PatientView.
const CG = "en" as const

// NEW tints Care Teal; duration / higher-dose flags tint Coral for attention.
function flagTone(flag: string): "new" | "caution" {
  const lower = flag.toLowerCase()
  if (lower.includes("more day") || lower.includes("higher dose")) {
    return "caution"
  }
  return "new"
}

function ChecklistProgress({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <div className="track-progress">
      <span className="track-progress-count">
        {t(CG, "progressComplete", { done, total })}
      </span>
      <div className="checklist-progress" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// Focused, management-oriented view for a caregiver. A caregiver sees ONLY the
// patient they are linked to — never the full provider dashboard — and can
// track items on the patient's behalf.
export function CaregiverView({
  session,
  onLogout,
}: {
  session: Session
  onLogout: () => void
}) {
  const patientId = session.caregiverPatientIds?.[0]
  // TODO: replace with real backend call — GET /p/:token (caregiver-scoped),
  // including expiresAt for the deletion countdown.
  const record = patientId ? mockDischargeByPatient[patientId] : undefined
  const plan = record?.byLang.en

  const { isChecked, toggle, progressFor } = useChecklist(patientId)

  return (
    <div className="role-shell caregiver-shell">
      <header className="role-header">
        <div className="role-header-brand">
          <div className="brand-mark">
            <BrandMark size={26} />
          </div>
          <span>Discharge AI</span>
        </div>
        <div className="role-header-actions">
          <div className="role-identity">
            <strong>{session.displayName}</strong>
            <span>{session.subtitle}</span>
          </div>
          <button className="logout-button" onClick={onLogout} type="button">
            <Icon name="logout" size={16} />
            {t(CG, "signOut")}
          </button>
        </div>
      </header>

      <main className="role-main">
        <div className="role-intro">
          <p className="eyebrow">{t(CG, "caregiverEyebrow")}</p>
          <h1>{plan ? plan.title : t(CG, "caregiverPlanFallback")}</h1>
          <p className="heading-support">{t(CG, "caregiverLede")}</p>
          {record ? (
            <DeletionTimer createdAt={record.createdAt} language={CG} />
          ) : null}
        </div>

        {!plan ? (
          <section className="side-card" aria-live="polite">
            <p>{t(CG, "caregiverNoPatient")}</p>
          </section>
        ) : (
          <CaregiverPlan
            plan={plan}
            isChecked={isChecked}
            onToggle={toggle}
            progressFor={progressFor}
          />
        )}
      </main>
    </div>
  )
}

function CaregiverPlan({
  plan,
  isChecked,
  onToggle,
  progressFor,
}: {
  plan: DischargePlan
  isChecked: (id: string) => boolean
  onToggle: (id: string) => void
  progressFor: (ids: string[]) => { done: number; total: number }
}) {
  const medIds = plan.medications.groups
    .flatMap((g) => g.items)
    .filter((m) => m.trackable)
    .map((m) => m.id)
  const medProgress = progressFor(medIds)

  return (
    <div className="caregiver-stack">
      <section className="side-card" aria-label={t(CG, "caregiverMedicationsTitle")}>
        <div className="side-card-head">
          <h3>{t(CG, "caregiverMedicationsTitle")}</h3>
          {medIds.length > 0 ? (
            <ChecklistProgress done={medProgress.done} total={medProgress.total} />
          ) : null}
        </div>
        <p className="caregiver-intro">{plan.medications.intro}</p>
        {plan.medications.groups.map((grp) => (
          <div className="med-group" key={grp.key}>
            <h4 className="med-group-label">{grp.label}</h4>
            {grp.key === "asNeeded" ? (
              <ul className="med-plain-list">
                {grp.items.map((med) => (
                  <li className="med-plain" key={med.id}>
                    <CaregiverMedCopy med={med} />
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="track-list track-list-dense">
                {grp.items.map((med) => (
                  <li key={med.id}>
                    <button
                      aria-pressed={isChecked(med.id)}
                      className={`track-item track-item-dense ${
                        isChecked(med.id) ? "is-done" : ""
                      }`}
                      onClick={() => onToggle(med.id)}
                      type="button"
                    >
                      <span className="track-box track-box-dense">
                        {isChecked(med.id) ? (
                          <Icon name="check" size={14} />
                        ) : null}
                      </span>
                      <span className="track-copy">
                        <CaregiverMedCopy med={med} />
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
        <section className="side-card" aria-label={t(CG, "newMedicinesTitle")}>
          <div className="side-card-head">
            <h3>{t(CG, "newMedicinesTitle")}</h3>
          </div>
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
        <section className="side-card" aria-label={t(CG, "stoppedMedicinesTitle")}>
          <div className="side-card-head">
            <h3>{t(CG, "stoppedMedicinesTitle")}</h3>
          </div>
          <ul className="stopped-list">
            {plan.stoppedMedicines.map((item) => (
              <li className="stopped-item" key={item.name}>
                <span className="stopped-icon" aria-hidden="true">
                  <Icon name="stop" size={16} />
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

      <section className="side-card" aria-label={t(CG, "caregiverTodosTitle")}>
        <div className="side-card-head">
          <h3>{t(CG, "caregiverTodosTitle")}</h3>
        </div>
        <CaregiverTodo
          title={t(CG, "labsTitle")}
          items={plan.todos.labs}
          emptyLine={t(CG, "labsEmpty")}
          isChecked={isChecked}
          onToggle={onToggle}
          progressFor={progressFor}
        />
        <CaregiverTodo
          title={t(CG, "appointmentsTitle")}
          items={plan.todos.appointments}
          note={plan.todos.appointmentsNote}
          isChecked={isChecked}
          onToggle={onToggle}
          progressFor={progressFor}
        />
        <CaregiverTodo
          title={t(CG, "caregiverCareInstructionsTitle")}
          items={plan.todos.careInstructions}
          isChecked={isChecked}
          onToggle={onToggle}
          progressFor={progressFor}
        />
      </section>

      {plan.generalInstructions.length > 0 ? (
        <section className="side-card" aria-label={t(CG, "generalInstructionsTitle")}>
          <div className="side-card-head">
            <h3>{t(CG, "generalInstructionsTitle")}</h3>
          </div>
          <ul className="general-list general-list-dense">
            {plan.generalInstructions.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        className="side-card warning-signs warning-signs-dense"
        role="alert"
        aria-label={plan.warningSigns.heading}
      >
        <h3 className="warning-signs-title">
          <Icon name="warning" size={18} /> {plan.warningSigns.heading}
        </h3>
        <ul className="warning-signs-list">
          {plan.warningSigns.signs.map((sign, index) => (
            <li key={index}>{sign}</li>
          ))}
        </ul>
        <p className="warning-signs-emergency">
          <Icon name="warning" size={16} /> {plan.warningSigns.emergencyLine}
        </p>
      </section>

      {plan.whyHospitalized.length > 0 ? (
        <section className="side-card" aria-label={t(CG, "whyHospitalizedTitle")}>
          <div className="side-card-head">
            <h3>{t(CG, "whyHospitalizedTitle")}</h3>
          </div>
          <ul className="general-list general-list-dense">
            {plan.whyHospitalized.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function CaregiverMedCopy({ med }: { med: MedItem }) {
  return (
    <span className="med-text">
      <span className="med-name-row">
        <strong className="med-name med-name-dense">{med.name}</strong>
        {med.flag ? (
          <span className={`med-flag med-flag-${flagTone(med.flag)}`}>
            {med.flag}
          </span>
        ) : null}
      </span>
      <span className="med-reason med-reason-dense">{med.reason}</span>
    </span>
  )
}

function CaregiverTodo({
  title,
  items,
  emptyLine,
  note,
  isChecked,
  onToggle,
  progressFor,
}: {
  title: string
  items: CheckItem[]
  emptyLine?: string
  note?: string
  isChecked: (id: string) => boolean
  onToggle: (id: string) => void
  progressFor: (ids: string[]) => { done: number; total: number }
}) {
  const progress = progressFor(items.map((i) => i.id))
  return (
    <div className="todo-group todo-group-dense">
      <div className="todo-group-head">
        <h4 className="todo-group-title">{title}</h4>
        {items.length > 0 ? (
          <ChecklistProgress done={progress.done} total={progress.total} />
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="todo-empty">{emptyLine}</p>
      ) : (
        <ul className="track-list track-list-dense">
          {items.map((item) => (
            <li key={item.id}>
              <button
                aria-pressed={isChecked(item.id)}
                className={`track-item track-item-dense ${
                  isChecked(item.id) ? "is-done" : ""
                }`}
                onClick={() => onToggle(item.id)}
                type="button"
              >
                <span className="track-box track-box-dense">
                  {isChecked(item.id) ? <Icon name="check" size={14} /> : null}
                </span>
                <span className="track-copy">
                  <span className="track-label track-label-dense">
                    {item.label}
                  </span>
                  {item.detail ? (
                    <span className="track-detail track-detail-dense">
                      {item.detail}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {note ? <p className="todo-note">{note}</p> : null}
    </div>
  )
}
