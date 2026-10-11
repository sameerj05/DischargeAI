// Trackable checklist state for the Going-Home Plan.
//
// HIPAA-aware: we persist ONLY the set of CHECKED opaque item ids (e.g.
// "med-ex1-furosemide-am", "lab-ex1-kidney") in sessionStorage, keyed per
// patient. We NEVER persist drug names, diagnoses, DOB, or any clinical text —
// the ids are opaque strings assigned in data.ts. sessionStorage (not
// localStorage) better matches a clinical session and clears when the tab
// closes.
//
// TODO: when the real backend exists, checklist completion could sync via an
// authed PATCH (e.g. PATCH /p/:token/checklist); for now it is local-only
// session state.

import { useCallback, useState } from "react"

// Separate from the auth SESSION_STORAGE_KEY so session + checklist never
// collide. Keyed per patient id below.
const CHECKLIST_STORAGE_PREFIX = "dai.checklist"

function storageKey(patientId: string): string {
  return `${CHECKLIST_STORAGE_PREFIX}.${patientId}`
}

function readChecked(patientId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(storageKey(patientId))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    // Keep only opaque string ids; ignore anything else that slipped in.
    return new Set(parsed.filter((v): v is string => typeof v === "string"))
  } catch {
    return new Set()
  }
}

function writeChecked(patientId: string, checked: Set<string>): void {
  try {
    // Store only opaque ids — never clinical text. Do NOT console.log these.
    sessionStorage.setItem(storageKey(patientId), JSON.stringify([...checked]))
  } catch {
    // Non-fatal: progress simply won't survive a reload.
  }
}

// Hook: trackable checklist state for one patient's plan. Returns the set of
// checked opaque ids, a toggle, and a progress helper. State persists across a
// page refresh via sessionStorage.
export function useChecklist(patientId: string | undefined) {
  const [checked, setChecked] = useState<Set<string>>(() =>
    patientId ? readChecked(patientId) : new Set(),
  )

  const toggle = useCallback(
    (id: string) => {
      setChecked((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        if (patientId) writeChecked(patientId, next)
        return next
      })
    },
    [patientId],
  )

  const isChecked = useCallback((id: string) => checked.has(id), [checked])

  // Count how many of the given ids are checked (for "N of M complete").
  const progressFor = useCallback(
    (ids: string[]) => {
      const done = ids.reduce((n, id) => (checked.has(id) ? n + 1 : n), 0)
      return { done, total: ids.length }
    },
    [checked],
  )

  return { isChecked, toggle, progressFor }
}
