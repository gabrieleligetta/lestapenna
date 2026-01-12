# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lestapenna is a Discord bot for D&D/tabletop RPG session recording, transcription, and narrative summarization. It acts as a "digital bard" that joins voice channels, records player conversations, transcribes them using Whisper, corrects transcriptions with AI, and generates narrative summaries.

## Commands

```bash
# Development
npm run dev          # Run with nodemon + ts-node (hot reload)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled JS from dist/

# The bot runs in Docker with Redis for job queues
# Whisper.cpp runs inside the container at /app/whisper/
```

## Architecture

### Core Flow
1. **Voice Recording** (`voicerecorder.ts`) - Joins Discord voice channels, captures per-user audio streams, encodes to MP3 via FFmpeg, injects silence for timing accuracy
2. **Job Queue** (`queue.ts`) - BullMQ queues backed by Redis: `audio-processing` (transcription) and `correction-processing` (AI post-processing)
3. **Worker** (`worker.ts`) - Processes audio jobs: downloads from cloud backup, transcribes via Whisper.cpp, filters hallucinations, queues for AI correction
4. **Transcription** (`transcriptionService.ts`) - Whisper.cpp wrapper with Italian language, anti-hallucination parameters, JSON output parsing
5. **Bard AI** (`bard.ts`) - Multi-provider OpenAI/Ollama integration for: transcription correction, metadata extraction (NPCs, locations), narrative summaries, RAG-based Q&A, embeddings

### Data Layer
- **Database** (`db.ts`) - SQLite via better-sqlite3, WAL mode. Schema includes: campaigns, characters, sessions, recordings, knowledge_fragments (RAG), NPCs, quests, inventory, location atlas, world history
- **Backup** (`backupService.ts`) - Oracle Cloud Object Storage for audio file persistence

### Key Components
- **Session Mixer** (`sessionMixer.ts`, `streamingMixer.ts`) - Combines per-user audio into single session MP3
- **Identity Guard** (`identityGuard.ts`) - NPC name deduplication via Discord interaction prompts
- **Whisper Filter** (`whisperHallucinationFilter.ts`) - Removes common Whisper artifacts (music descriptions, repeated phrases)
- **Monitor** (`monitor.ts`) - Session metrics: audio duration, processing times, file operations
- **Reporter** (`reporter.ts`) - Email session recaps via nodemailer

### AI Provider Configuration
The bard supports per-phase provider selection via environment variables:
- `TRANSCRIPTION_PROVIDER`, `METADATA_PROVIDER`, `MAP_PROVIDER`, `SUMMARY_PROVIDER`, `CHAT_PROVIDER`, `EMBEDDING_PROVIDER`
- Each can be `'ollama'` or `'openai'` with corresponding model env vars

### Discord Commands
Bot commands use `$` prefix (e.g., `$ascolta`, `$listen`, `$chiedialbardo`). Main command categories:
- Campaign management: create, select, delete campaigns
- Session control: listen, pause, resume, terminate
- Location tracking: macro/micro location system with atlas memory
- NPC dossier: automatic extraction, merge, manual editing
- Narrative: summaries with tones (epic, funny, dark, concise, DM)
- RAG Q&A: ask the bard about campaign lore

## Key Patterns

### Transcription Pipeline
Recording → MP3 (FFmpeg with loudnorm) → Whisper.cpp (Italian, anti-hallucination) → Hallucination filter → AI correction (GPT/Ollama) → Structured output with NPCs, locations

### RAG System
Knowledge fragments are stored with embeddings (text-embedding-3-small or nomic-embed-text). Dual indexing supports both OpenAI and Ollama embeddings simultaneously.

### Location System
Two-tier location tracking: macro (city/region) and micro (specific place). Locations are auto-detected from transcripts and stored in an "atlas" with evolving descriptions.

## Environment Variables

Required: `DISCORD_TOKEN`, `OPENAI_API_KEY` (or Ollama config)
Database stored at `data/dnd_bot.db`, recordings at `recordings/`