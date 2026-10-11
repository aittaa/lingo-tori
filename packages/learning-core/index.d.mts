export interface Note {
  id: string
  term: string
  meaning: string
  context: string
  language: string
  sourceUrl: string
  updatedAt: number
}
export type Rating = "again" | "hard" | "good" | "easy"
export interface ReviewEvent {
  id: string
  cardId: string
  rating: Rating
  reviewedAt: number
}
export interface Card {
  id: string
  noteId: string
  dueAt: number
  intervalDays: number
  repetitions: number
  lapses: number
  lastReviewedAt: number | null
  schedulerVersion: "simple-v1"
}
export interface LearningState {
  schemaVersion: 1
  notes: Note[]
  cards: Card[]
  reviews: ReviewEvent[]
}
export const SCHEMA_VERSION: 1
export const SCHEDULER_VERSION: "simple-v1"
export function createState(): LearningState
export function validateNote(note: Note): Note
export function validateReview(event: ReviewEvent): ReviewEvent
export function mergeStates(...states: LearningState[]): LearningState
export function saveNote(state: LearningState, note: Note): LearningState
export function reviewCard(state: LearningState, event: ReviewEvent): LearningState
export function dueCards(state: LearningState, now?: number): Card[]

export function canonicalNoteId(
  term: string,
  language: string,
  state?: LearningState,
): Promise<string>

export function normalizeLearningLanguage(language: string): string
