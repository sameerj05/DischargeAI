// Accessible text-size preference for the patient view.
//
// NOTE: full WCAG conformance requires real assistive-technology testing (screen
// readers, OS zoom, reflow). This implements the best-practice building blocks:
// discrete, labeled, keyboard-operable steps that scale a single CSS variable so
// headings, body, checklist labels, and buttons grow together, persisted so the
// choice survives a reload.
//
// This is a non-PHI UI preference, so it uses the SAME sessionStorage try/catch
// pattern as checklist.ts / auth.ts (clears when the tab closes).

import { useCallback, useState } from "react"

export type FontStep = "normal" | "large" | "xlarge"

// Multiplier applied to the patient content via --patient-font-scale.
export const FONT_SCALES: Record<FontStep, number> = {
  normal: 1,
  large: 1.15,
  xlarge: 1.3,
}

// Ordered steps for the −/+ controls.
export const FONT_STEPS: FontStep[] = ["normal", "large", "xlarge"]

const FONT_STORAGE_KEY = "dai.fontScale"

function isFontStep(value: unknown): value is FontStep {
  return value === "normal" || value === "large" || value === "xlarge"
}

function readStep(): FontStep {
  try {
    const raw = sessionStorage.getItem(FONT_STORAGE_KEY)
    return isFontStep(raw) ? raw : "normal"
  } catch {
    return "normal"
  }
}

function writeStep(step: FontStep): void {
  try {
    sessionStorage.setItem(FONT_STORAGE_KEY, step)
  } catch {
    // Non-fatal: the preference simply won't survive a reload.
  }
}

// Hook: current font step + scale, a setter, and −/+ steppers. The chosen step
// persists across a page refresh via sessionStorage.
export function useFontScale() {
  const [step, setStep] = useState<FontStep>(() => readStep())

  const setFontStep = useCallback((next: FontStep) => {
    setStep(next)
    writeStep(next)
  }, [])

  const decrease = useCallback(() => {
    setStep((prev) => {
      const i = FONT_STEPS.indexOf(prev)
      const next = FONT_STEPS[Math.max(0, i - 1)]
      writeStep(next)
      return next
    })
  }, [])

  const increase = useCallback(() => {
    setStep((prev) => {
      const i = FONT_STEPS.indexOf(prev)
      const next = FONT_STEPS[Math.min(FONT_STEPS.length - 1, i + 1)]
      writeStep(next)
      return next
    })
  }, [])

  return { step, scale: FONT_SCALES[step], setFontStep, decrease, increase }
}
