import { useCallback, useEffect, useRef, useState } from "react"

export type ReadAloudState = "idle" | "speaking" | "paused"

/**
 * Finds the best available SpeechSynthesisVoice for a BCP-47 lang tag.
 * Priority:
 *   1. Exact match on lang (e.g. "zh-CN")
 *   2. Same base language (e.g. any "zh-*" voice)
 *   3. null — browser picks its default
 */
function findVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return null

  const base = lang.split("-")[0].toLowerCase()

  // 1. Exact match
  const exact = voices.find(
    (v) => v.lang.toLowerCase() === lang.toLowerCase(),
  )
  if (exact) return exact

  // 2. Same base language — prefer a local (non-network) voice if available
  const sameBase = voices.filter((v) =>
    v.lang.toLowerCase().startsWith(base),
  )
  if (sameBase.length) {
    return sameBase.find((v) => !v.localService === false) ?? sameBase[0]
  }

  return null
}

/**
 * Hook that wraps the Web Speech API SpeechSynthesis.
 * Returns a speak function and the current state.
 * Calling speak() while already speaking the same text cancels it (toggle).
 */
export function useReadAloud() {
  const [state, setState] = useState<ReadAloudState>("idle")
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  // voices load asynchronously — track them so findVoice works after load
  const [, setVoicesLoaded] = useState(0)

  useEffect(() => {
    // Voices may already be available (Chrome) or load async (Safari/Firefox)
    const onVoicesChanged = () => setVoicesLoaded((n) => n + 1)
    window.speechSynthesis.addEventListener("voiceschanged", onVoicesChanged)
    // Trigger once in case voices are already loaded
    if (window.speechSynthesis.getVoices().length) {
      setVoicesLoaded((n) => n + 1)
    }
    return () => {
      window.speechSynthesis.removeEventListener(
        "voiceschanged",
        onVoicesChanged,
      )
      window.speechSynthesis.cancel()
    }
  }, [])

  const stop = useCallback(() => {
    window.speechSynthesis.cancel()
    setState("idle")
    utteranceRef.current = null
  }, [])

  const speak = useCallback(
    (text: string, lang = "en-US") => {
      if (!window.speechSynthesis) return

      // Toggle off if already speaking
      if (state === "speaking" || state === "paused") {
        stop()
        return
      }

      window.speechSynthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = lang
      utterance.rate = 0.92
      utterance.pitch = 1

      // Explicitly assign a matching voice so the browser doesn't fall back
      // to the OS default (which is almost always English)
      const voice = findVoice(lang)
      if (voice) utterance.voice = voice

      utterance.onstart = () => setState("speaking")
      utterance.onend = () => {
        setState("idle")
        utteranceRef.current = null
      }
      utterance.onerror = () => {
        setState("idle")
        utteranceRef.current = null
      }

      utteranceRef.current = utterance
      window.speechSynthesis.speak(utterance)
    },
    [state, stop],
  )

  return { speak, stop, state }
}
