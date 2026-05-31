const DEFAULT_USER_COMMAND_NOTIFICATION_MAX_CHARS = 1600;
const DEFAULT_USER_COMMAND_NOTIFICATION_MAX_CHUNKS = 3;

function positiveInt(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function userCommandNotificationMaxChars(options = {}) {
  return positiveInt(
    options.userCommandNotificationMaxChars
      || process.env.BRIDGE_USER_COMMAND_NOTIFICATION_MAX_CHARS,
    DEFAULT_USER_COMMAND_NOTIFICATION_MAX_CHARS,
  );
}

export function userCommandNotificationMaxChunks(options = {}) {
  return positiveInt(
    options.userCommandNotificationMaxChunks
      || process.env.BRIDGE_USER_COMMAND_NOTIFICATION_MAX_CHUNKS,
    DEFAULT_USER_COMMAND_NOTIFICATION_MAX_CHUNKS,
  );
}

export function userCommandNotificationChunks(text, options = {}) {
  const value = String(text || '');
  const maxChars = positiveInt(options.maxChars, userCommandNotificationMaxChars(options));
  const maxChunks = positiveInt(options.maxChunks, userCommandNotificationMaxChunks(options));
  const notice = options.notice || `\n\n…\n[User Command notification truncated: original_chars=${value.length}; full command was recorded and dispatched.]`;
  const chunks = [];

  if (!value) {
    return { chunks: ['(empty)'], truncated: false, length: 0, maxChars, maxChunks };
  }

  let offset = 0;
  for (let index = 0; index < maxChunks && offset < value.length; index += 1) {
    const remaining = value.slice(offset);
    const isLastAllowedChunk = index === maxChunks - 1;
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      offset = value.length;
      break;
    }

    if (isLastAllowedChunk) {
      const headMax = Math.max(0, maxChars - notice.length);
      chunks.push(`${remaining.slice(0, headMax)}${notice}`);
      offset = value.length;
      return { chunks, truncated: true, length: value.length, maxChars, maxChunks };
    }

    chunks.push(remaining.slice(0, maxChars));
    offset += maxChars;
  }

  return { chunks, truncated: offset < value.length, length: value.length, maxChars, maxChunks };
}

export function limitUserCommandNotificationText(text, options = {}) {
  const result = userCommandNotificationChunks(text, options);
  return { ...result, text: result.chunks.join('\n\n') };
}
