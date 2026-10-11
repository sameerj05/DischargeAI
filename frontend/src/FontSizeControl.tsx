// Accessible text-size control for the patient view: A− / step buttons / A+.
//
// Keyboard operable (native buttons), screen-reader labeled via i18n, large tap
// targets. The active step is marked with aria-pressed. See fontScale.ts for
// the WCAG note.

import { Icon } from "./ui"
import { FONT_STEPS, type FontStep } from "./fontScale"
import { t, type UIKey } from "./i18n"
import { type Language } from "./data"

const STEP_LABEL_KEY: Record<FontStep, UIKey> = {
  normal: "fontSizeNormal",
  large: "fontSizeLarge",
  xlarge: "fontSizeExtraLarge",
}

export function FontSizeControl({
  language,
  step,
  onStep,
  onDecrease,
  onIncrease,
}: {
  language: Language
  step: FontStep
  onStep: (step: FontStep) => void
  onDecrease: () => void
  onIncrease: () => void
}) {
  const atMin = step === FONT_STEPS[0]
  const atMax = step === FONT_STEPS[FONT_STEPS.length - 1]

  return (
    <div
      aria-label={t(language, "fontSizeLabel")}
      className="font-control"
      role="group"
    >
      <span className="font-control-icon" aria-hidden="true">
        <Icon name="textSize" size={20} />
      </span>
      <span className="font-control-label">{t(language, "fontSizeLabel")}</span>
      <div className="font-control-buttons">
        <button
          aria-label={t(language, "fontDecrease")}
          className="font-step-button"
          disabled={atMin}
          onClick={onDecrease}
          type="button"
        >
          A−
        </button>
        {FONT_STEPS.map((s) => (
          <button
            aria-pressed={step === s}
            className={`font-step-button font-step-named ${
              step === s ? "font-step-active" : ""
            }`}
            key={s}
            onClick={() => onStep(s)}
            type="button"
          >
            {t(language, STEP_LABEL_KEY[s])}
          </button>
        ))}
        <button
          aria-label={t(language, "fontIncrease")}
          className="font-step-button"
          disabled={atMax}
          onClick={onIncrease}
          type="button"
        >
          A+
        </button>
      </div>
    </div>
  )
}
