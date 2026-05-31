import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

export async function ensureDirFor(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export function parseJsonLine(line) {
  if (!line || line.trim() === '') return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function readJsonl(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const content = await readFile(filePath, 'utf8').catch(() => '');
  return content
    .split('\n')
    .map(parseJsonLine)
    .filter(Boolean);
}

export async function readJsonlStreaming(filePath, onRecord) {
  if (!filePath || !existsSync(filePath)) return;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    const parsed = parseJsonLine(line);
    if (parsed) await onRecord(parsed, lineNumber);
  }
}

export async function listFilesRecursive(root, predicate = () => true) {
  if (!root || !existsSync(root)) return [];
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() && predicate(path, entry.name)) {
        files.push(path);
      }
    }
  }
  const withStats = await Promise.all(files.map(async (file) => ({ file, mtimeMs: (await stat(file)).mtimeMs })));
  return withStats.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.file);
}
