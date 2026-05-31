import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bridgeStateRoot } from './bridge-paths.js';

const DEFAULT_INLINE_TEXT_BYTES = 4096;
const PREVIEW_CHARS = 1200;

function positiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function inlineTextBytes(options = {}) {
  return positiveInt(
    process.env.BRIDGE_EVENT_BODY_INLINE_BYTES || options.eventBodyInlineBytes,
    DEFAULT_INLINE_TEXT_BYTES,
  );
}

function bodyRoot(options = {}) {
  return options.eventBodyRoot || process.env.BRIDGE_EVENT_BODY_ROOT || join(bridgeStateRoot(options), 'event-bodies');
}

function sha256(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function bodyPath(hash, options = {}) {
  return join(bodyRoot(options), hash.slice(0, 2), `${hash}.md`);
}

function eventTextByteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function previewText(text) {
  const value = String(text || '');
  return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
}

export function eventBodyRefPath(ref = {}, options = {}) {
  if (!ref || ref.kind !== 'file' || ref.algorithm !== 'sha256' || !ref.hash) return null;
  return ref.path || bodyPath(ref.hash, options);
}

export async function spoolEventBodyIfNeeded(event = {}, options = {}) {
  const text = typeof event.text === 'string' ? event.text : '';
  const bytes = eventTextByteLength(text);
  if (!text || bytes <= inlineTextBytes(options) || event.bodyRef || event.body_ref) return event;

  const hash = sha256(text);
  const path = bodyPath(hash, options);
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await writeFile(tmpPath, text, 'utf8');
    try {
      await rename(tmpPath, path);
    } catch (error) {
      if (!existsSync(path)) throw error;
      await unlink(tmpPath).catch(() => {});
    }
  }

  return {
    ...event,
    text: previewText(text),
    text_truncated: true,
    bodyRef: {
      kind: 'file',
      algorithm: 'sha256',
      hash,
      bytes,
      path,
    },
  };
}

export async function hydrateEventBodyText(event = {}, options = {}) {
  const ref = event.bodyRef || event.body_ref || null;
  if (!ref) return typeof event.text === 'string' ? event.text : '';
  const path = eventBodyRefPath(ref, options);
  if (!path) throw new Error('Invalid event body reference');
  const text = await readFile(path, 'utf8');
  const hash = sha256(text);
  if (hash !== ref.hash) throw new Error(`Event body hash mismatch: ${path}`);
  const bytes = eventTextByteLength(text);
  if (ref.bytes != null && bytes !== ref.bytes) throw new Error(`Event body byte length mismatch: ${path}`);
  return text;
}
