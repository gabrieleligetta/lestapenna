import { Transform, TransformCallback } from 'stream';

// --- CONFIGURAZIONE AUDIO ---
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BIT_DEPTH = 16;
// Byte al secondo: 48000 * 2 canali * 2 bytes (16bit) = 192,000 bytes/sec
const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8)) / 1000;

// Tolleranza Jitter: Se il gap è minore di 40ms, lo ignoriamo (è normale latenza di rete)
const JITTER_THRESHOLD_MS = 40;
// Massimo silenzio iniettabile in un colpo solo (per evitare blocchi di memoria enormi)
const MAX_SILENCE_ALLOC_BYTES = 192000 * 10; // ~10 secondi max per chunk

export class PcmSilenceInjector extends Transform {
    private lastChunkTime: number = 0;
    private firstPacketReceived: boolean = false;

    constructor() {
        super();
    }

    _transform(chunk: Buffer, encoding: string, callback: TransformCallback) {
        const now = Date.now();

        if (!this.firstPacketReceived) {
            this.firstPacketReceived = true;
            this.lastChunkTime = now;
            this.push(chunk);
            callback();
            return;
        }

        // Calcola quanto tempo è passato dall'ultimo chunk processato
        const deltaMs = now - this.lastChunkTime;

        // Gap rilevato = Tempo Attuale - (Tempo Ultimo Chunk + Durata Stimata Standard 20ms)
        // Usiamo un approccio conservativo: se il delta è > JITTER_THRESHOLD_MS + 20ms standard

        if (deltaMs > (JITTER_THRESHOLD_MS + 20)) {
            // C'è un buco di silenzio.
            // Calcoliamo quanti millisecondi mancano.
            // Sottraiamo 20ms che è la durata "fisiologica" del pacchetto appena arrivato o del precedente.
            const silenceDurationMs = deltaMs - 20;

            if (silenceDurationMs > 0) {
                // Calcola quanti byte di silenzio servono
                const silenceBytes = Math.floor(silenceDurationMs * BYTES_PER_MS);

                // Allinea a 4 byte (block align per stereo 16bit) per evitare rumore statico
                const alignedSilenceBytes = silenceBytes - (silenceBytes % 4);

                if (alignedSilenceBytes > 0) {
                    // Crea buffer di silenzio (pieno di zeri)
                    // Lo spezziamo se è troppo grande per non far crashare la memoria
                    let remaining = alignedSilenceBytes;
                    while (remaining > 0) {
                        const size = Math.min(remaining, MAX_SILENCE_ALLOC_BYTES);
                        this.push(Buffer.alloc(size));
                        remaining -= size;
                    }
                }
            }
        }

        this.lastChunkTime = now;
        this.push(chunk);
        callback();
    }
    
    // Getter per accedere a lastChunkTime dall'esterno (usato per il controllo inattività)
    public getLastChunkTime(): number {
        return this.lastChunkTime;
    }
}
