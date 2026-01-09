import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    joinVoiceChannel,
    EndBehaviorType,
    getVoiceConnection,
    VoiceConnection
} from '@discordjs/voice';
import { VoiceBasedChannel } from 'discord.js';
import * as fs from 'fs';
import * as prism from 'prism-media';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LoggerService } from '../logger/logger.service';
import { PcmSilenceInjector } from './pcm-silence-injector';
import { AudioChunkSavedEvent } from '../events/audio.events';
import { BackupService } from '../backup/backup.service';
import { PodcastMixerService } from './podcast-mixer.service';
import { SessionRepository } from '../session/session.repository';
import { RecordingRepository } from './recording.repository';
import { CampaignRepository } from '../campaign/campaign.repository';
import * as mm from 'music-metadata';

const execAsync = promisify(exec);

interface ActiveStream {
    out: fs.WriteStream;
    decoder: prism.opus.Decoder;
    encoder: prism.FFmpeg;
    silenceInjector: PcmSilenceInjector;
    opusStream: any;
    currentPath: string;
    connectionStartTime: number;
    sessionId: string;
    rotationTimer?: NodeJS.Timeout;
    chunks: string[];
    lastActivity: number;
}

@Injectable()
export class AudioService implements OnModuleDestroy {
    private activeStreams = new Map<string, ActiveStream>();
    private connectionErrors = new Map<string, number>();
    private pausedGuilds = new Set<string>();

    private readonly CHUNK_DURATION_MS = 5 * 60 * 1000; // 5 Minuti
    private readonly IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minuti

    constructor(
        private readonly logger: LoggerService,
        private readonly eventEmitter: EventEmitter2,
        private readonly backupService: BackupService,
        private readonly podcastMixerService: PodcastMixerService,
        private readonly sessionRepo: SessionRepository,
        private readonly recordingRepo: RecordingRepository,
        private readonly campaignRepo: CampaignRepository
    ) {}

    async onModuleDestroy() {
        this.logger.log('[AudioService] 🛑 Shutdown rilevato. Chiusura controllata delle sessioni...');
        
        // Identifica tutte le gilde attive
        const activeGuilds = new Set<string>();
        for (const key of this.activeStreams.keys()) {
            const guildId = key.split('-')[0];
            if (guildId) activeGuilds.add(guildId);
        }

        // Esegue disconnect per ogni gilda (che gestisce chiusura stream, mixaggio e upload)
        const promises = Array.from(activeGuilds).map(guildId => this.disconnect(guildId));
        
        try {
            await Promise.all(promises);
            this.logger.log('[AudioService] ✅ Tutte le sessioni audio sono state chiuse e salvate.');
        } catch (error) {
            this.logger.error('[AudioService] ❌ Errore durante la chiusura degli stream:', error);
        }
    }

    pauseRecording(guildId: string) {
        this.pausedGuilds.add(guildId);
        this.logger.log(`[Recorder] ⏸️ Registrazione in PAUSA per Guild ${guildId}`);
        const keysToClose: string[] = [];
        for (const [key] of this.activeStreams) {
            if (key.startsWith(`${guildId}-`)) keysToClose.push(key);
        }
        keysToClose.forEach(key => this.closeStream(key));
    }

    resumeRecording(guildId: string) {
        this.pausedGuilds.delete(guildId);
        this.logger.log(`[Recorder] ▶️ Registrazione RIPRESA per Guild ${guildId}`);
    }

    isRecordingPaused(guildId: string): boolean {
        return this.pausedGuilds.has(guildId);
    }

    async connectToChannel(channel: VoiceBasedChannel, sessionId: string) {
        if (!channel.guild) return;
        const guildId = channel.guild.id;
        this.pausedGuilds.delete(guildId);

        const existingStart = this.sessionRepo.findById(sessionId);
        
        if (existingStart && !existingStart.start_time) {
            this.sessionRepo.updateStartTime(sessionId, Date.now());
            this.logger.log(`[Recorder] 🕒 Tempo Zero fissato per sessione ${sessionId}`);
        }

        const connection: VoiceConnection = joinVoiceChannel({
            channelId: channel.id,
            guildId: guildId,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        this.logger.log(`🎙️  Connesso al canale: ${channel.name} (Sessione: ${sessionId})`);

        connection.receiver.speaking.on('start', (userId: string) => {
            if (this.pausedGuilds.has(guildId)) return;
            const user = channel.client.users.cache.get(userId);
            if (user?.bot) return;

            this.createListeningStream(connection, userId, sessionId, guildId);
        });
    }

    private createEncoder(): prism.FFmpeg {
        return new prism.FFmpeg({
            args: [
                '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', '-',
                '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3',
            ],
        });
    }

    private createListeningStream(connection: VoiceConnection, userId: string, sessionId: string, guildId: string) {
        const streamKey = `${guildId}-${userId}`;
        if (this.activeStreams.has(streamKey)) return;

        const lastError = this.connectionErrors.get(streamKey) || 0;
        if (Date.now() - lastError < 1000) return;

        this.logger.log(`[Recorder] 🆕 Creazione stream per ${userId}`);

        const receiver = connection.receiver;
        const opusStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.Manual },
        });

        const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const silenceInjector = new PcmSilenceInjector();
        let encoder = this.createEncoder();

        const getNewFile = () => {
            const filename = `${userId}-${Date.now()}.mp3`;
            const filepath = path.join(process.cwd(), 'recordings', filename);
            const recordingsDir = path.dirname(filepath);
            if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });
            return { out: fs.createWriteStream(filepath), filepath, filename };
        };

        let { out, filepath, filename } = getNewFile();
        const connectionStartTime = Date.now();

        const handleError = (err: Error, source: string) => {
            if (err.message === 'Premature close') return;
            this.logger.warn(`⚠️ Errore Audio (${source}) per ${userId}: ${err.message}`);
            if (source === 'OpusStream') {
                this.closeStream(streamKey);
                this.connectionErrors.set(streamKey, Date.now());
            }
        };

        opusStream.on('error', (e: Error) => handleError(e, 'OpusStream'));
        decoder.on('error', (e) => handleError(e, 'Decoder'));
        silenceInjector.on('error', (e) => handleError(e, 'SilenceInjector'));
        encoder.on('error', (e) => handleError(e, 'Encoder'));

        opusStream
            .pipe(decoder)
            .pipe(silenceInjector)
            .pipe(encoder)
            .pipe(out);

        const rotationTimer = setInterval(async () => {
            const streamData = this.activeStreams.get(streamKey);
            if (!streamData) {
                clearInterval(rotationTimer);
                return;
            }

            const lastActivity = streamData.silenceInjector.getLastChunkTime() || Date.now();
            if (Date.now() - lastActivity > this.IDLE_TIMEOUT_MS) {
                this.logger.log(`[Recorder] 💤 Timeout inattività per ${userId}.`);
                this.closeStream(streamKey);
                return;
            }

            const oldEncoder = streamData.encoder;
            const oldOut = streamData.out;
            const oldPath = streamData.currentPath;
            const oldName = path.basename(oldPath);

            streamData.silenceInjector.unpipe(oldEncoder);

            oldEncoder.end();
            oldOut.on('finish', () => {
                this.backupService.uploadToOracle(oldPath, oldName, sessionId).catch(e => this.logger.error(e));
            });

            const newFile = getNewFile();
            const newEncoder = this.createEncoder();

            streamData.out = newFile.out;
            streamData.encoder = newEncoder;
            streamData.currentPath = newFile.filepath;
            streamData.chunks.push(newFile.filename);

            newEncoder.on('error', (e) => handleError(e, 'Encoder-Rotated'));
            streamData.out.on('error', (e) => handleError(e, 'FileWrite-Rotated'));

            streamData.silenceInjector.pipe(newEncoder).pipe(streamData.out);

        }, this.CHUNK_DURATION_MS);

        this.activeStreams.set(streamKey, {
            out, decoder, encoder, silenceInjector, opusStream,
            currentPath: filepath, connectionStartTime, sessionId, rotationTimer,
            chunks: [filename],
            lastActivity: Date.now()
        });

        this.logger.log(`[Recorder] ⏺️  Stream avviato per ${userId}`);
    }

    async closeStream(streamKey: string) {
        const stream = this.activeStreams.get(streamKey);
        if (!stream) return;

        if (stream.rotationTimer) clearInterval(stream.rotationTimer);

        try { stream.opusStream.destroy(); } catch {}
        try { stream.decoder.destroy(); } catch {}
        try { stream.silenceInjector.destroy(); } catch {}
        try { stream.encoder.destroy(); } catch {}

        this.activeStreams.delete(streamKey);

        return new Promise<void>((resolve) => {
            if (stream.out && !stream.out.writableEnded) {
                stream.out.end();
                stream.out.on('finish', async () => {
                    const filename = path.basename(stream.currentPath);
                    await this.backupService.uploadToOracle(stream.currentPath, filename, stream.sessionId);

                    const guildId = streamKey.split('-')[0];
                    const userId = streamKey.split('-')[1];
                    await this.mergeAndUploadSession(userId, stream.chunks, stream.sessionId, guildId, stream.connectionStartTime);
                    resolve();
                });
                stream.out.on('error', () => resolve());
            } else {
                resolve();
            }
        });
    }

    async disconnect(guildId: string): Promise<boolean> {
        const connection = getVoiceConnection(guildId);
        if (connection) {
            this.logger.log(`[Recorder] Disconnessione Guild ${guildId}...`);

            let sessionId: string | undefined;
            const keysToClose: string[] = [];

            for (const [key, stream] of this.activeStreams) {
                if (key.startsWith(`${guildId}-`)) {
                    keysToClose.push(key);
                    if (!sessionId) sessionId = stream.sessionId;
                }
            }

            const closePromises = keysToClose.map(key => this.closeStream(key));
            await Promise.all(closePromises);

            await new Promise(resolve => setTimeout(resolve, 1500));

            if (sessionId) {
                try {
                    const masterPath = await this.podcastMixerService.mixSession(sessionId);
                    if (masterPath) {
                        const outputFilename = path.basename(masterPath);
                        const customKey = `recordings/${sessionId}/master/${outputFilename}`;
                        await this.backupService.uploadToOracle(masterPath, outputFilename, sessionId, customKey);
                        this.logger.log(`[Recorder] 🎹 Master Mix creato: ${outputFilename}`);
                    }
                } catch (e) {
                    this.logger.error(`[Recorder] ❌ Errore Master Mix:`, e);
                }
            }

            connection.destroy();
            return true;
        }
        return false;
    }

    private async mergeAndUploadSession(userId: string, chunks: string[], sessionId: string, guildId: string, startTime: number) {
        const recordingsDir = path.join(process.cwd(), 'recordings');
        const validChunks = chunks.filter(f => fs.existsSync(path.join(recordingsDir, f)));

        if (validChunks.length === 0) return;

        this.logger.log(`[Recorder] 🔗 Merge ${validChunks.length} files per ${userId}...`);

        const outputFilename = `FULL-${userId}-${Date.now()}.mp3`;
        const outputPath = path.join(recordingsDir, outputFilename);
        const listPath = path.join(recordingsDir, `list-${sessionId}-${userId}-${Date.now()}.txt`);

        const fileContent = validChunks.map(f => `file '${path.join(recordingsDir, f)}'`).join('\n');
        fs.writeFileSync(listPath, fileContent);

        const command = `ffmpeg -f concat -safe 0 -i "${listPath}" -filter:a loudnorm -c:a libmp3lame -b:a 128k "${outputPath}"`;

        try {
            await execAsync(command);
            try { fs.unlinkSync(listPath); } catch {}

            await this.processFinalFile(userId, outputPath, outputFilename, sessionId, guildId, startTime);

            for (const chunk of validChunks) {
                try { fs.unlinkSync(path.join(recordingsDir, chunk)); } catch {}
            }
        } catch (error) {
            this.logger.error(`[Recorder] ❌ Errore FFmpeg Merge:`, error);
        }
    }

    private async processFinalFile(userId: string, filePath: string, fileName: string, sessionId: string, guildId: string, startTime: number) {
        const loc = this.sessionRepo.getLastLocation(guildId);
        const campaign = this.campaignRepo.findActive(guildId);

        this.recordingRepo.create(
            sessionId, 
            fileName, 
            filePath, 
            userId, 
            startTime, 
            loc?.macro || undefined, 
            loc?.micro || undefined,
            campaign?.current_year
        );

        const customKey = `recordings/${sessionId}/full/${fileName}`;
        try {
            await this.backupService.uploadToOracle(filePath, fileName, sessionId, customKey);
            this.recordingRepo.updateStatus(fileName, 'SECURED');
        } catch (e) {
            this.logger.error(`[Recorder] ❌ Errore upload FULL:`, e);
        }

        let durationMs = 0;
        try {
            const metadata = await mm.parseFile(filePath);
            durationMs = (metadata.format.duration || 0) * 1000;
        } catch (e: any) {
            this.logger.warn(`[Recorder] Impossibile calcolare durata audio: ${e.message}`);
        }

        // EMETTI EVENTO invece di chiamare QueueService direttamente
        this.eventEmitter.emit('audio.chunk.saved', new AudioChunkSavedEvent(
            sessionId,
            fileName,
            filePath,
            userId,
            startTime,
            durationMs
        ));

        this.logger.log(`[Recorder] ✅ Traccia utente salvata e inviata: ${fileName} (${(durationMs/1000).toFixed(1)}s)`);
    }
}
