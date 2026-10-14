import { Sha256Hex } from "@/utils/hash"

/**
 * The part of a message sender that says whether it lives in a private window.
 * Every content script is sent from a tab, so `sender.tab` is how the
 * background tells a private window from a normal one.
 */
type PrivateSenderCandidate = { tab?: { incognito?: boolean } } | undefined

/**
 * Whether a message was sent from a tab in a private (incognito) window.
 *
 * The background is one shared context that writes to one persistent IndexedDB,
 * so a private tab's text would otherwise land in the same cache as everything
 * else. Handlers use this to leave the persistent caches alone for such a tab.
 *
 * Fails open on purpose: a sender without a tab (an extension page, an old
 * message shape) or without the field counts as a normal sender, which keeps the
 * existing persistent behaviour. Only an explicit `true` is private.
 */
export function isPrivateSender(sender: PrivateSenderCandidate): boolean {
  return sender?.tab?.incognito === true
}

/**
 * The key a queue dedups on. A private sender's key is moved into its own
 * namespace so its request can never be merged with — or cancelled through — a
 * normal sender's request for the same text, and vice versa. A normal sender's
 * key is returned untouched, so nothing changes for it.
 *
 * An empty key stays empty: the queues read it as "do not dedup", and hashing it
 * would turn every unkeyed private request into one shared request.
 */
export function getQueueIdentity(key: string, isPrivate: boolean): string {
  return isPrivate && key ? Sha256Hex("private-sender", key) : key
}
