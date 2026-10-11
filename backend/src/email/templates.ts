/**
 * The emails carry the link and the expiry date, nothing else. The summary itself only ever lives
 * behind the link, so an inbox never holds PHI. The product speaks as itself here; it never writes
 * a message for a person to send as their own.
 */
export interface LinkEmail {
  to: string;
  subject: string;
  text: string;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** The note's wording: "Your discharge summary is ready at this link". Sent to the patient's email. */
export function patientLinkEmail(input: { to: string; link: string; expiresAt: string }): LinkEmail {
  return {
    to: input.to,
    subject: "Your discharge summary is ready",
    text: [
      `Your discharge summary is ready at this link: ${input.link}`,
      "",
      `This link works until ${formatDate(input.expiresAt)}. After that date the information is permanently deleted and cannot be recovered.`,
      "",
      "If you did not expect this message, you can ignore it. Do not forward the link; it is yours alone.",
    ].join("\n"),
  };
}

/** The team contract: the same link also goes to the patient's caregiverEmail. */
export function caregiverLinkEmail(input: { to: string; link: string; expiresAt: string }): LinkEmail {
  return {
    to: input.to,
    subject: "A discharge summary is ready for someone in your care",
    text: [
      `You are listed as a caregiver. The discharge summary is ready at this link: ${input.link}`,
      "",
      `This link works until ${formatDate(input.expiresAt)}. After that date the information is permanently deleted and cannot be recovered.`,
      "",
      "If you did not expect this message, you can ignore it. Please do not forward the link.",
    ].join("\n"),
  };
}
