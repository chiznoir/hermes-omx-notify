export const DISCORD_SAFE_MESSAGE_CHARS = 1800;

export function truncateText(value, max = 80) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function enforceDiscordSafeMessageLimit(content, max = DISCORD_SAFE_MESSAGE_CHARS) {
  const text = String(content || '');
  return text.length <= max ? text : text.slice(0, max);
}
