// 30-day secure-deletion countdown shown near the top of the patient and
// caregiver views.
//
// The backend sets expiresAt = createdAt + 30 days (DynamoDB TTL + S3
// lifecycle). This surfaces the days remaining in a calm, non-alarming teal
// badge (coral is reserved for the 911 / warning block). Day precision is
// enough, so it refreshes once an hour; the interval is cleaned up on unmount.
//
// TODO: use the real expiresAt from GET /p/:token instead of createdAt + 30d.

import { useEffect, useState } from "react"
import { Icon } from "./ui"
import { daysUntilDeletion, t } from "./i18n"
import { type Language } from "./data"

export function DeletionTimer({
  createdAt,
  language,
}: {
  createdAt: number
  language: Language
}) {
  const [days, setDays] = useState(() => daysUntilDeletion(createdAt))

  useEffect(() => {
    setDays(daysUntilDeletion(createdAt))
    const id = setInterval(
      () => setDays(daysUntilDeletion(createdAt)),
      60 * 60 * 1000,
    )
    return () => clearInterval(id)
  }, [createdAt])

  const message =
    days <= 0
      ? t(language, "deletionCountdownToday")
      : days === 1
        ? t(language, "deletionCountdownOneDay")
        : t(language, "deletionCountdown", { days })

  return (
    <p className="deletion-timer">
      <span className="deletion-timer-icon" aria-hidden="true">
        <Icon name="clock" size={18} />
      </span>
      <span>{message}</span>
    </p>
  )
}
