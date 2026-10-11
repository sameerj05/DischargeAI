import { useEffect, useRef } from "react"

// Auto-logout after a period of user inactivity.
//
// `timeoutMs` comes from IDLE_TIMEOUT_MS in auth.ts. While `active` is true we
// listen for common user-activity events and reset a single timer on each; the
// timer firing calls `onTimeout` (which clears the session and returns to
// login). Setup/teardown is idempotent so it is safe under React StrictMode's
// double-invoked effects in development.
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  "mousemove",
  "keydown",
  "click",
  "scroll",
  "touchstart",
]

export function useIdleTimeout(
  active: boolean,
  timeoutMs: number,
  onTimeout: () => void,
): void {
  // Keep the latest callback in a ref so the effect doesn't re-subscribe on
  // every render when the handler identity changes.
  const onTimeoutRef = useRef(onTimeout)
  onTimeoutRef.current = onTimeout

  useEffect(() => {
    if (!active) return

    let timer = window.setTimeout(() => onTimeoutRef.current(), timeoutMs)

    const reset = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => onTimeoutRef.current(), timeoutMs)
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true })
    }

    return () => {
      window.clearTimeout(timer)
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, reset)
      }
    }
  }, [active, timeoutMs])
}
