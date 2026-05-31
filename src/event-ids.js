import { createHash } from 'node:crypto';

const EVENT_ID_TEXT_HASH_PREFIX_LENGTH = 24;

function textDigest(text) {
  return createHash('sha256')
    .update(String(text || ''))
    .digest('base64url')
    .slice(0, EVENT_ID_TEXT_HASH_PREFIX_LENGTH);
}

export function fallbackEventId(session = {}, event = {}) {
  return [
    session.bridgeSessionId,
    event.source,
    event.type,
    event.timestamp,
    event.text ? `text:${textDigest(event.text)}` : null,
  ].filter(Boolean).join(':');
}

export function normalizeEventId(session = {}, event = {}) {
  return event.eventId || fallbackEventId(session, event);
}
