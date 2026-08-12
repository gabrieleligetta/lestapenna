/**
 * Discord Helper Utilities
 */

import { TextChannel, Message } from 'discord.js';

/**
 * Splits a long text into chunks that fit within Discord's 2000 character limit.
 * Tries to split at newlines first, then spaces, to avoid breaking words.
 */
export function splitMessage(text: string, maxLength: number = 2000): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let currentChunk = '';

    const lines = text.split('\n');

    for (const line of lines) {
        if (currentChunk.length + line.length + 1 > maxLength) {
            // Check if adding this line would exceed logic
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = '';
            }

            // If the line itself is too long, we must soft split it
            if (line.length > maxLength) {
                let remainingLine = line;
                while (remainingLine.length > 0) {
                    // Try to split at space
                    let splitIndex = remainingLine.lastIndexOf(' ', maxLength);
                    if (splitIndex === -1) splitIndex = maxLength; // Force split if no space

                    chunks.push(remainingLine.substring(0, splitIndex));
                    remainingLine = remainingLine.substring(splitIndex).trim();
                }
            } else {
                currentChunk = line;
            }
        } else {
            if (currentChunk.length > 0) currentChunk += '\n';
            currentChunk += line;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

/**
 * Safely sends a message to a channel, splitting it if necessary.
 */
export async function safeSend(channel: TextChannel, content: string): Promise<Message[]> {
    if (!content || content.trim().length === 0) return [];

    // Discord limit is 2000, we use 1950 to be safe
    const chunks = splitMessage(content, 1950);
    const sentMessages: Message[] = [];

    for (const chunk of chunks) {
        if (chunk.trim().length > 0) {
            const msg = await channel.send(chunk);
            sentMessages.push(msg);
        }
    }

    return sentMessages;
}

/**
 * Safely replies to a message, splitting if necessary.
 * First chunk is a reply, subsequent chunks are regular messages in the same channel.
 */
export async function safeReply(message: Message, content: string): Promise<Message[]> {
    if (!content || content.trim().length === 0) return [];

    const chunks = splitMessage(content, 1950);
    const sentMessages: Message[] = [];

    // First chunk is a reply
    if (chunks.length > 0) {
        sentMessages.push(await message.reply(chunks[0]));
    }

    // Subsequent chunks are normal messages
    for (let i = 1; i < chunks.length; i++) {
        if (chunks[i].trim().length > 0) {
            // Check if channel is TextBased
            if (message.channel && 'send' in message.channel) {
                // @ts-ignore - We know it has send if it's a TextChannel-like
                const msg = await message.channel.send(chunks[i]);
                sentMessages.push(msg);
            }
        }
    }

    return sentMessages;
}
