import { useEffect, useState } from "react"
import { getSummary, getTranslation } from "./api"
import { adaptSummary } from "./planAdapter"
import type { Language } from "./data"

export function useDischarge(token: string | undefined, language: Language = "en") {
  const [value, setValue] = useState<ReturnType<typeof adaptSummary>>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    setValue(undefined); setError(undefined)
    if (!token) { setError("Use the patient link from a completed writeup."); return }
    const load = language === "en" ? getSummary(token) : getTranslation(token, language)
    load.then(response => { if (active) setValue(adaptSummary(response)) })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : "Could not load the plan") })
    return () => { active = false }
  }, [token, language])
  return { value, error, loading: !value && !error }
}
