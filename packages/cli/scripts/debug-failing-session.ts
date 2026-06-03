import { parseSessionFile } from '@chat-recall/engine/parsers/session.js';
import { chunkSession } from '@chat-recall/engine/parsers/chunker.js';

const sessionPath = '/home/user/.claude/projects/-home-user-code-personal-poly/69e1acbe-5c59-4bc4-a707-80089c1cfd03.jsonl';

const content = await parseSessionFile(sessionPath);
const entry = {
  sessionId: '69e1acbe-5c59-4bc4-a707-80089c1cfd03',
  projectPath: '/home/user/code/personal/poly',
  created: '2025-01-25',
  modified: '2025-01-25',
  fileMtime: Date.now(),
};

const chunks = chunkSession(entry as any, content);

console.log('Number of chunks:', chunks.length);
console.log('Chunk types:', chunks.map(c => c.chunkType));
console.log('Chunk text lengths:', chunks.map(c => c.text.length));
