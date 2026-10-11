// Searchable language dropdown (hand-built WAI-ARIA combobox + listbox).
//
// Replaces the old .lang-toggle button group. No new npm dependency: just React
// state + the existing Icon system. Searchable (filters on endonym AND English
// name), shows a script-glyph symbol per language, fully keyboard operable
// (Enter/Space to open, type to filter, Arrow keys to move, Enter to select,
// Esc to close), and works under RTL since it inherits the container's `dir`.

import { useEffect, useId, useRef, useState } from "react"
import { Icon } from "./ui"
import { LANGUAGES, type Language } from "./data"
import { t } from "./i18n"

export function LanguagePicker({
  language,
  onChange,
}: {
  language: Language
  onChange: (code: Language) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const listboxId = useId()
  const optionId = (index: number) => `${listboxId}-opt-${index}`

  const current = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0]

  const filtered = LANGUAGES.filter((lang) => {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return (
      lang.name.toLowerCase().includes(q) ||
      lang.label.toLowerCase().includes(q)
    )
  })

  // Focus the search input when the menu opens; reset filter + active option.
  useEffect(() => {
    if (open) {
      setQuery("")
      const selected = filtered.findIndex((l) => l.code === language)
      setActiveIndex(selected >= 0 ? selected : 0)
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep the active option within the filtered range as the query narrows.
  useEffect(() => {
    setActiveIndex((prev) => Math.min(prev, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDocPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", onDocPointer)
    return () => document.removeEventListener("pointerdown", onDocPointer)
  }, [open])

  function select(code: Language) {
    onChange(code)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function onTriggerKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault()
      setOpen(true)
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const choice = filtered[activeIndex]
      if (choice) select(choice.code)
    } else if (e.key === "Escape") {
      e.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
  }

  return (
    <div className="lang-picker" ref={rootRef}>
      <span className="lang-picker-label" id={`${listboxId}-label`}>
        {t(language, "languageLabel")}
      </span>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={`${listboxId}-label ${listboxId}-value`}
        className="lang-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span className="lang-symbol" aria-hidden="true">
          {current.symbol}
        </span>
        <span className="lang-picker-value" id={`${listboxId}-value`}>
          {current.label}
          <span className="lang-picker-value-name">{current.name}</span>
        </span>
        <span className="lang-picker-caret" aria-hidden="true">
          <Icon name="chevron" size={16} />
        </span>
      </button>

      {open ? (
        <div className="lang-picker-menu">
          <div className="lang-picker-search">
            <span className="lang-picker-search-icon" aria-hidden="true">
              <Icon name="search" size={16} />
            </span>
            <input
              aria-activedescendant={
                filtered[activeIndex] ? optionId(activeIndex) : undefined
              }
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-expanded={true}
              aria-label={t(language, "languageSearchPlaceholder")}
              className="lang-picker-input"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={t(language, "languageSearchPlaceholder")}
              ref={inputRef}
              role="combobox"
              type="text"
              value={query}
            />
          </div>
          <ul
            aria-label={t(language, "languageLabel")}
            className="lang-picker-list"
            id={listboxId}
            role="listbox"
          >
            {filtered.length === 0 ? (
              <li className="lang-picker-empty" role="presentation">
                {t(language, "languageNoMatches")}
              </li>
            ) : (
              filtered.map((lang, index) => (
                <li
                  aria-selected={lang.code === language}
                  className={`lang-option ${
                    index === activeIndex ? "lang-option-active" : ""
                  } ${lang.code === language ? "lang-option-selected" : ""}`}
                  id={optionId(index)}
                  key={lang.code}
                  onClick={() => select(lang.code)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                >
                  <span className="lang-symbol" aria-hidden="true">
                    {lang.symbol}
                  </span>
                  <span className="lang-option-copy">
                    <span className="lang-option-endonym">{lang.label}</span>
                    <span className="lang-option-name">{lang.name}</span>
                  </span>
                  {lang.code === language ? (
                    <span className="lang-option-check" aria-hidden="true">
                      <Icon name="check" size={16} />
                    </span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
