/**
 * Utility: Save debug file
 */

import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../config';

const MAX_DEBUG_FILE_SIZE = 5 * 1024 * 1024; // 5MB max per debug file

export function saveDebugFile(sessionId: string, filename: string, content: string) {
    try {
        const debugDir = path.join(config.paths.transcriptsDir, sessionId, 'debug_prompts');
        if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
        }
        const truncated = content.length > MAX_DEBUG_FILE_SIZE
            ? content.substring(0, MAX_DEBUG_FILE_SIZE) + '\n\n[TRUNCATED — exceeded 5MB limit]'
            : content;
        fs.writeFileSync(path.join(debugDir, filename), truncated, 'utf-8');
    } catch (e) {
        console.error(`[Debug] Failed to save ${filename}:`, e);
    }
}
