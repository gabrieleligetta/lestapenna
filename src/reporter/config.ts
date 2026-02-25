/**
 * Reporter Config
 */

import * as nodemailer from 'nodemailer';
import OpenAI from 'openai';
import { config, loadAiConfig } from '../config';

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

const aiCfg = loadAiConfig();
const chatPhase = aiCfg.phases.chat;

const reporterApiKey =
    chatPhase.provider === 'gemini' ? config.ai.gemini.apiKey :
    chatPhase.provider === 'ollama' ? 'ollama' :
    config.ai.openAi.apiKey;

const reporterBaseURL =
    chatPhase.provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/' :
    chatPhase.provider === 'ollama' ? aiCfg.ollama.remoteUrl :
    undefined;

export const openaiReporterClient = new OpenAI({
    baseURL: reporterBaseURL,
    project: chatPhase.provider === 'openai' ? (config.ai.openAi.projectId || undefined) : undefined,
    apiKey: reporterApiKey,
});

export const REPORT_MODEL = chatPhase.model;
