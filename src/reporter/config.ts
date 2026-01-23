/**
 * Reporter Config
 */

import * as nodemailer from 'nodemailer';
import OpenAI from 'openai';
import { config } from '../config';

// Configurazione SMTP per Porkbun
export const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: true,
    auth: {
        user: config.smtp.user,
        pass: config.smtp.pass
    }
});

export const openaiReporterClient = new OpenAI({
    baseURL: config.ai.provider === 'ollama' ? config.ai.ollama.baseUrl : undefined,
    project: config.ai.provider === 'ollama' ? undefined : config.ai.openAi.projectId,
    apiKey: config.ai.provider === 'ollama' ? 'ollama' : config.ai.openAi.apiKey,
});

export const REPORT_MODEL = config.ai.provider === 'ollama'
    ? config.ai.ollama.model
    : config.ai.openAi.model;
