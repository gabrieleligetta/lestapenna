/**
 * Reporter Config
 */

import * as nodemailer from 'nodemailer';
import OpenAI from 'openai';

// Configurazione SMTP per Porkbun
export const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.porkbun.com",
    port: parseInt(process.env.SMTP_PORT || "465"),
    secure: true,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

export const openaiReporterClient = new OpenAI({
    baseURL: process.env.AI_PROVIDER === 'ollama' ? (process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1') : undefined,
    project: process.env.AI_PROVIDER === 'ollama' ? undefined : process.env.OPENAI_PROJECT_ID,
    apiKey: process.env.AI_PROVIDER === 'ollama' ? 'ollama' : process.env.OPENAI_API_KEY,
});

export const REPORT_MODEL = process.env.AI_PROVIDER === 'ollama'
    ? (process.env.OLLAMA_MODEL || "llama3.2")
    : (process.env.OPEN_AI_MODEL || "gpt-4o-mini");
