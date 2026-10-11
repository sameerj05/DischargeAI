/** Partial results replace their own segment; finalized segments are never duplicated. */
export class DictationTranscript {
  private segments = new Map<string, { text: string; partial: boolean }>()
  update(id: string, text: string, partial: boolean) {
    if (!id || !text.trim() || this.segments.get(id)?.partial === false) return this.text
    this.segments.set(id, { text: text.trim(), partial })
    return this.text
  }
  get text() { return [...this.segments.values()].map(value => value.text).join(" ") }
}
