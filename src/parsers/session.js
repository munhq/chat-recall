/**
 * Session parser for Claude Code JSONL files.
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join, basename } from 'path';
function removeCodeBlocks(text) {
    // Remove fenced code blocks
    let result = text.replace(/```[\s\S]*?```/g, '[code block]');
    // Remove inline code
    result = result.replace(/`[^`]+`/g, '[code]');
    return result;
}
function extractKeyText(text, maxLength = 800) {
    // Remove code blocks
    let result = removeCodeBlocks(text);
    // Remove common boilerplate phrases
    const boilerplate = [
        /^Let me /i,
        /^I'll /i,
        /^I will /i,
        /^Now I'll /i,
        /^Here's what /i,
    ];
    for (const pattern of boilerplate) {
        result = result.replace(pattern, '');
    }
    // Normalize whitespace
    result = result.replace(/\s+/g, ' ').trim();
    return result.slice(0, maxLength);
}
function isValuableToolResult(content, toolName = '') {
    if (!content || content.length < 20) {
        return false;
    }
    // Skip common low-value results
    const skipPatterns = [
        /^Tool ran without output/i,
        /^No (?:matches|results) found/i,
        /^File (?:created|updated|deleted)/i,
        /^Command completed/i,
        /^\s*$/,
    ];
    for (const pattern of skipPatterns) {
        if (pattern.test(content)) {
            return false;
        }
    }
    // Prioritize web search results
    if (['WebSearch', 'WebFetch'].includes(toolName) || content.toLowerCase().includes('http')) {
        return true;
    }
    // Skip very long outputs (likely file contents or logs)
    if (content.length > 5000) {
        return false;
    }
    return true;
}
export function parseSessionsIndex(indexPath) {
    if (!existsSync(indexPath)) {
        return [];
    }
    const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const entries = data.entries || [];
    return entries.map((e) => ({
        sessionId: e.sessionId || '',
        fullPath: e.fullPath || '',
        fileMtime: e.fileMtime || 0,
        firstPrompt: e.firstPrompt || '',
        messageCount: e.messageCount || 0,
        created: e.created || '',
        modified: e.modified || '',
        gitBranch: e.gitBranch || '',
        projectPath: e.projectPath || '',
        isSidechain: e.isSidechain || false,
    }));
}
export function* iterAllSessionIndices(claudeDir) {
    const dir = claudeDir || join(homedir(), '.claude', 'projects');
    if (!existsSync(dir)) {
        return;
    }
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const projectDir = join(dir, entry.name);
        const indexPath = join(projectDir, 'sessions-index.json');
        if (existsSync(indexPath)) {
            const sessions = parseSessionsIndex(indexPath);
            if (sessions.length > 0) {
                yield [projectDir, sessions];
            }
        }
    }
}
export async function parseSessionFile(sessionPath, maxMessages = 50) {
    const sessionId = basename(sessionPath, '.jsonl');
    const content = {
        sessionId,
        sessionPath,
        summaries: [],
        userMessages: [],
        assistantMessages: [],
        toolResults: [],
        toolsUsed: new Set(),
        firstPrompt: '',
    };
    if (!existsSync(sessionPath)) {
        return content;
    }
    let userCount = 0;
    let assistantCount = 0;
    let toolCount = 0;
    const fileStream = createReadStream(sessionPath);
    const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
    });
    let lineNum = 0;
    for await (const line of rl) {
        lineNum++;
        if (!line.trim())
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            continue;
        }
        try {
            const msgType = obj.type;
            if (msgType === 'summary') {
                const summary = obj.summary;
                if (summary) {
                    content.summaries.push(summary);
                }
            }
            else if (msgType === 'user') {
                if (userCount >= maxMessages)
                    continue;
                const msg = obj.message;
                let text = '';
                if (msg && typeof msg === 'object') {
                    const msgContent = msg.content;
                    if (typeof msgContent === 'string') {
                        text = msgContent;
                    }
                    else if (Array.isArray(msgContent)) {
                        const textParts = [];
                        for (const item of msgContent) {
                            if (typeof item === 'object' && item !== null) {
                                const itemObj = item;
                                if (itemObj.type === 'text') {
                                    textParts.push(itemObj.text || '');
                                }
                                else if (itemObj.type === 'tool_result') {
                                    const result = itemObj.content;
                                    if (typeof result === 'string' && isValuableToolResult(result) && toolCount < maxMessages) {
                                        content.toolResults.push({
                                            text: result.slice(0, 2000),
                                            lineNumber: lineNum,
                                            contentType: 'tool_result',
                                        });
                                        toolCount++;
                                    }
                                }
                            }
                        }
                        text = textParts.join('\n');
                    }
                }
                // Skip system reminders and very short messages
                if (text && !text.includes('<system-reminder>') && text.trim().length > 10) {
                    content.userMessages.push({
                        text,
                        lineNumber: lineNum,
                        contentType: 'user',
                    });
                    userCount++;
                    // Capture first prompt
                    if (!content.firstPrompt) {
                        content.firstPrompt = text.slice(0, 1000);
                    }
                }
            }
            else if (msgType === 'assistant') {
                if (assistantCount >= maxMessages)
                    continue;
                const msg = obj.message;
                if (!msg || typeof msg !== 'object')
                    continue;
                const msgContent = msg.content;
                if (Array.isArray(msgContent)) {
                    for (const item of msgContent) {
                        if (typeof item !== 'object' || item === null)
                            continue;
                        const itemObj = item;
                        const itemType = itemObj.type;
                        if (itemType === 'text') {
                            const text = itemObj.text;
                            if (text && typeof text === 'string') {
                                const keyText = extractKeyText(text);
                                if (keyText && keyText.length > 50) {
                                    content.assistantMessages.push({
                                        text: keyText,
                                        lineNumber: lineNum,
                                        contentType: 'assistant',
                                    });
                                    assistantCount++;
                                }
                                break;
                            }
                        }
                        else if (itemType === 'tool_use') {
                            const toolName = itemObj.name;
                            if (toolName) {
                                content.toolsUsed.add(toolName);
                            }
                        }
                    }
                }
                else if (typeof msgContent === 'string') {
                    const keyText = extractKeyText(msgContent);
                    if (keyText && keyText.length > 50) {
                        content.assistantMessages.push({
                            text: keyText,
                            lineNumber: lineNum,
                            contentType: 'assistant',
                        });
                        assistantCount++;
                    }
                }
            }
            // Also check for toolUseResult (web search results, etc.)
            const toolResult = obj.toolUseResult;
            if (toolResult && typeof toolResult === 'object' && toolCount < maxMessages) {
                const resultText = toolResult.result;
                const query = toolResult.query;
                if (resultText && typeof resultText === 'string' && isValuableToolResult(resultText, 'WebSearch')) {
                    const searchText = query ? `Search: ${query}\n${resultText}` : resultText;
                    content.toolResults.push({
                        text: searchText.slice(0, 2000),
                        lineNumber: lineNum,
                        contentType: 'web_search',
                    });
                    toolCount++;
                }
            }
        }
        catch {
            // Skip malformed messages
            continue;
        }
    }
    return content;
}
export function* getAllSessions(claudeDir) {
    const dir = claudeDir || join(homedir(), '.claude', 'projects');
    const seenSessionIds = new Set();
    // First, yield sessions from sessions-index.json files
    for (const [, entries] of iterAllSessionIndices(claudeDir)) {
        for (const entry of entries) {
            if (existsSync(entry.fullPath)) {
                seenSessionIds.add(entry.sessionId);
                yield [entry, entry.fullPath];
            }
        }
    }
    // Then scan for .jsonl files that aren't in any index
    if (!existsSync(dir))
        return;
    const projectDirs = readdirSync(dir, { withFileTypes: true });
    for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory())
            continue;
        const projectPath = join(dir, projectDir.name);
        const files = readdirSync(projectPath);
        for (const file of files) {
            // Only process .jsonl files (not agent files, not index files)
            if (!file.endsWith('.jsonl'))
                continue;
            if (file.startsWith('agent-'))
                continue;
            if (file === 'sessions-index.json')
                continue;
            const sessionId = basename(file, '.jsonl');
            // Skip if already processed from index
            if (seenSessionIds.has(sessionId))
                continue;
            const fullPath = join(projectPath, file);
            try {
                const stat = statSync(fullPath);
                // Derive project path from directory name
                // e.g., "-home-user-code-acme" -> "/home/user/code/acme"
                const derivedProjectPath = projectDir.name
                    .replace(/^-/, '/')
                    .replace(/-/g, '/');
                const entry = {
                    sessionId,
                    fullPath,
                    fileMtime: stat.mtimeMs,
                    firstPrompt: '', // Will be populated during parsing
                    messageCount: 0,
                    created: stat.birthtime.toISOString(),
                    modified: stat.mtime.toISOString(),
                    gitBranch: '',
                    projectPath: derivedProjectPath,
                    isSidechain: false,
                };
                seenSessionIds.add(sessionId);
                yield [entry, fullPath];
            }
            catch {
                // Skip files we can't stat
                continue;
            }
        }
    }
}
