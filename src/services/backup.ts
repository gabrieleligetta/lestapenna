import 'dotenv/config';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, ListObjectsV2CommandOutput, ListBucketsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { config } from '../config';

let _s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
    if (!_s3Client) {
        const { region, endpoint, accessKeyId, secretAccessKey } = config.oci;

        if (!region || !endpoint || !accessKeyId || !secretAccessKey) {
            console.error("[Custode] ⚠️ Variabili d'ambiente OCI mancanti o incomplete!");
        }

        console.log(`[Custode] 🛠️ Inizializzazione S3 Client. Region: ${region}, Endpoint: ${endpoint}`);

        _s3Client = new S3Client({
            region: region,
            endpoint: endpoint,
            credentials: {
                accessKeyId: accessKeyId,
                secretAccessKey: secretAccessKey,
            },
            forcePathStyle: true
        });
    }
    return _s3Client;
}

export const getBucketName = () => config.oci.bucketName;

/**
 * Utility per ottenere la chiave S3 preferita (nuova struttura con sessionId)
 */
function getPreferredKey(fileName: string, sessionId?: string): string {
    return sessionId ? `recordings/${sessionId}/${fileName}` : `recordings/${fileName}`;
}

/**
 * Verifica se un file esiste nel bucket OCI, controllando sia il nuovo percorso che quello legacy.
 * Ritorna la Key se trovato, null altrimenti.
 */
async function findS3Key(fileName: string, sessionId?: string): Promise<string | null> {
    // 1. Prova il percorso specifico per la sessione (se fornito)
    if (sessionId) {
        // Se fileName contiene già un path (es. transcripts/...), usalo direttamente
        const sessionKey = fileName.includes('/') ? fileName : `recordings/${sessionId}/${fileName}`;
        try {
            await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: sessionKey }));
            return sessionKey;
        } catch (err: any) {
            if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                console.error(`[Custode] ❌ Errore verifica existence per ${sessionKey}:`, err);
            }
        }
    }

    // 2. Prova il percorso legacy (root di recordings)
    // Solo se fileName non è un path complesso
    if (!fileName.includes('/')) {
        const legacyKey = `recordings/${fileName}`;
        try {
            await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: legacyKey }));
            return legacyKey;
        } catch (err: any) {
            if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
                console.error(`[Custode] ❌ Errore verifica existence per ${legacyKey}:`, err);
            }
        }
    }

    return null;
}

/**
 * Carica un file su Oracle Cloud, solo se non è già presente.
 */
export async function uploadToOracle(filePath: string, fileName: string, sessionId?: string, customKey?: string): Promise<string | null> {
    try {
        // 1. Controllo se il file esiste già nel Cloud (in qualsiasi posizione)
        // Se customKey è fornito, saltiamo il controllo di esistenza "smart" e ci fidiamo
        if (!customKey) {
            const existingKey = await findS3Key(fileName, sessionId);
            if (existingKey) {
                console.log(`[Custode] ⏩ Salto upload, file già presente su Oracle: ${existingKey}`);
                return fileName;
            }
        }

        // 2. Controllo se il file locale esiste
        if (!fs.existsSync(filePath)) {
            console.error(`[Custode] ❌ Impossibile caricare: file locale non trovato ${filePath}`);
            return null;
        }

        const fileContent = fs.readFileSync(filePath);
        const targetKey = customKey ? customKey : getPreferredKey(fileName, sessionId);

        // Determiniamo il content type dall'estensione
        const extension = path.extname(fileName).toLowerCase();
        const contentType = extension === '.ogg' ? 'audio/ogg' :
            extension === '.mp3' ? 'audio/mpeg' :
                extension === '.flac' ? 'audio/flac' :
                    extension === '.json' ? 'application/json' :
                        extension === '.txt' ? 'text/plain' :
                            'audio/x-pcm';

        const command = new PutObjectCommand({
            Bucket: getBucketName(),
            Key: targetKey,
            Body: fileContent,
            ContentType: contentType
        });

        await getS3Client().send(command);
        console.log(`[Custode] ☁️ Backup completato su Oracle: ${targetKey}`);

        return fileName;
    } catch (err) {
        console.error(`[Custode] ❌ Errore backup su Oracle per ${fileName}:`, err);
        return null;
    }
}

/**
 * Elimina un file da Oracle Cloud.
 * Cerca il file sia nel percorso sessione che legacy e lo rimuove.
 */
export async function deleteFromOracle(fileName: string, sessionId?: string): Promise<boolean> {
    try {
        const key = await findS3Key(fileName, sessionId);

        // Se non trovato con findS3Key, proviamo comunque a cancellare la chiave target prevista
        // Questo gestisce il caso in cui findS3Key fallisca o vogliamo essere sicuri di pulire la destinazione
        const targetKey = key || getPreferredKey(fileName, sessionId);

        await getS3Client().send(new DeleteObjectCommand({
            Bucket: getBucketName(),
            Key: targetKey
        }));

        console.log(`[Custode] 🗑️ Eliminato da Oracle: ${targetKey}`);
        return true;
    } catch (err: any) {
        // Ignoriamo 404 in cancellazione
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            return true;
        }
        console.error(`[Custode] ❌ Errore eliminazione ${fileName}:`, err);
        return false;
    }
}

/**
 * Scarica un file dal bucket Oracle alla cartella locale.
 */
export async function downloadFromOracle(fileName: string, localPath: string, sessionId?: string): Promise<boolean> {
    try {
        const key = await findS3Key(fileName, sessionId);
        if (!key) {
            console.error(`[Custode] ❌ File non trovato nel Cloud (né in sessione né legacy): ${fileName}`);
            return false;
        }

        const command = new GetObjectCommand({
            Bucket: getBucketName(),
            Key: key,
        });

        const response = await getS3Client().send(command);

        if (response.Body) {
            // Assicuriamoci che la directory esista
            const dir = path.dirname(localPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const stream = response.Body as Readable;
            const fileStream = fs.createWriteStream(localPath);

            return new Promise((resolve, reject) => {
                stream.pipe(fileStream)
                    .on('error', (err) => {
                        console.error(`[Custode] ❌ Errore scrittura file locale ${fileName}:`, err);
                        reject(err);
                    })
                    .on('finish', () => {
                        console.log(`[Custode] 📥 File ripristinato da Oracle: ${fileName}`);
                        resolve(true);
                    });
            });
        }
        return false;
    } catch (err: any) {
        if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
            console.error(`[Custode] ❌ File non trovato nel Cloud: ${fileName}`);
        } else {
            console.error(`[Custode] ❌ Errore download da Oracle per ${fileName}:`, err);
        }
        return false;
    }
}

/**
 * Genera un URL firmato (Pre-Authenticated Request) per scaricare un file.
 * L'URL scade dopo il tempo specificato (default 1 ora).
 */
export async function getPresignedUrl(
    fileNameOrKey: string,
    sessionId?: string,
    expiresInSeconds: number = 3600
): Promise<string | null> {
    try {
        let key: string | null = null;

        // ✅ Se contiene '/', trattalo come chiave completa
        if (fileNameOrKey.includes('/')) {
            // Verifica se esiste davvero usando la chiave completa
            try {
                await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: fileNameOrKey }));
                key = fileNameOrKey;
            } catch (err: any) {
                if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                    // Non trovato, ritorna null così il chiamante sa che deve rigenerarlo
                    return null;
                }
                // Altri errori, logga e ritorna null
                console.error(`[Custode] ❌ Errore verifica chiave custom ${fileNameOrKey}:`, err);
                return null;
            }
        } else {
            // Comportamento legacy
            key = await findS3Key(fileNameOrKey, sessionId);

            if (!key) {
                // Se non trovato, proviamo a costruire la chiave target (magari non esiste ancora ma vogliamo l'URL per upload?)
                // No, getPresignedUrl per download (GetObject) richiede che l'oggetto esista o darà 404 al download.
                // Quindi se findS3Key fallisce, ritorniamo null.
                return null;
            }
        }

        const command = new GetObjectCommand({
            Bucket: getBucketName(),
            Key: key
        });

        const url = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
        console.log(`[Custode] 🔗 URL generato per ${key} (valido ${expiresInSeconds}s)`);
        return url;

    } catch (err) {
        console.error(`[Custode] ❌ Errore URL firmato per ${fileNameOrKey}:`, err);
        return null;
    }
}

/**
 * Svuota completamente il bucket.
 * ATTENZIONE: Operazione distruttiva.
 */
export async function wipeBucket(): Promise<number> {
    const bucket = getBucketName();
    const client = getS3Client();
    let totalDeleted = 0;

    // Prefissi espliciti da pulire per garantire che S3/Oracle li trovi
    // Aggiungiamo anche la root '' per sicurezza, ma iteriamo sui folder specifici
    const prefixes = ['recordings/', 'logs/', 'transcripts/'];

    console.log(`[Custode] 🧹 Inizio svuotamento COMPLETO bucket: ${bucket}...`);

    for (const prefix of prefixes) {
        let continuationToken: string | undefined = undefined;
        console.log(`[Custode] 🧹 Scansione prefisso: '${prefix}'...`);

        do {
            const listCommand: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken
            });

            const listResponse: ListObjectsV2CommandOutput = await client.send(listCommand);

            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                break;
            }

            const deletePromises = listResponse.Contents
                .filter((obj: any) => obj.Key)
                .map(async (obj: any) => {
                    try {
                        await client.send(new DeleteObjectCommand({
                            Bucket: bucket,
                            Key: obj.Key!
                        }));
                        console.log(`[Custode] 🗑️ Eliminato: ${obj.Key}`);
                        totalDeleted++;
                    } catch (e) {
                        console.error(`[Custode] Errore cancellazione ${obj.Key}:`, e);
                    }
                });

            await Promise.all(deletePromises);
            continuationToken = listResponse.NextContinuationToken;

        } while (continuationToken);
    }

    console.log(`[Custode] ✅ Eliminati ${totalDeleted} oggetti totali dal Cloud.`);
    return totalDeleted;
}

/**
 * Controlla lo spazio utilizzato su tutti i bucket OCI e lo confronta con il Free Tier (10GB).
 */
export async function checkStorageUsage(): Promise<void> {
    try {
        const client = getS3Client();
        const bucketsResponse = await client.send(new ListBucketsCommand({}));

        if (!bucketsResponse.Buckets || bucketsResponse.Buckets.length === 0) {
            console.log("[Oracle] ☁️ Nessun bucket trovato.");
            return;
        }

        let totalBytes = 0;
        let bucketCount = 0;
        const bucketDetails: string[] = [];

        for (const bucket of bucketsResponse.Buckets) {
            const bucketName = bucket.Name;
            if (!bucketName) continue;

            bucketCount++;
            let bucketBytes = 0;
            let continuationToken: string | undefined = undefined;

            do {
                const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                    Bucket: bucketName,
                    ContinuationToken: continuationToken
                });

                const response: ListObjectsV2CommandOutput = await client.send(listCmd);

                if (response.Contents) {
                    for (const obj of response.Contents) {
                        bucketBytes += obj.Size || 0;
                    }
                }

                continuationToken = response.NextContinuationToken;
            } while (continuationToken);

            totalBytes += bucketBytes;
            const bucketGB = bucketBytes / (1024 * 1024 * 1024);
            bucketDetails.push(`   - ${bucketName}: ${bucketGB.toFixed(2)} GB`);
        }

        const totalGB = totalBytes / (1024 * 1024 * 1024);
        const freeTierLimit = 10.0; // 10 GB Free Tier
        const percentUsed = (totalGB / freeTierLimit) * 100;

        // Colore log in base alla percentuale
        let icon = '🟢';
        if (percentUsed > 75) icon = '🟡';
        if (percentUsed > 90) icon = '🔴';

        console.log(`[Oracle] ${icon} Storage Usage (${bucketCount} buckets): ${totalGB.toFixed(2)} GB / ${freeTierLimit.toFixed(2)} GB (${percentUsed.toFixed(1)}%)`);
        if (bucketDetails.length > 0) {
            console.log(bucketDetails.join('\n'));
        }

    } catch (err: any) {
        console.error(`[Oracle] ❌ Errore controllo spazio storage: ${err.message}`);
    }
}

/**
 * Elimina i file RAW (.flac) di una sessione specifica per risparmiare spazio.
 * Preserva i file .mp3 (Master/Live) e .json (Trascrizioni).
 */
export async function deleteRawSessionFiles(sessionId: string): Promise<number> {
    const client = getS3Client();
    const bucket = getBucketName();
    const prefix = `recordings/${sessionId}/`;
    let deletedCount = 0;

    console.log(`[Custode] 🧹 Pulizia file RAW per sessione ${sessionId}...`);

    try {
        let continuationToken: string | undefined = undefined;
        do {
            const listCmd: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken
            });

            const response: ListObjectsV2CommandOutput = await client.send(listCmd);

            if (response.Contents && response.Contents.length > 0) {
                const objectsToDelete = response.Contents
                    .filter(obj => obj.Key && obj.Key.endsWith('.flac')) // Solo FLAC
                    .map(obj => ({ Key: obj.Key! }));

                if (objectsToDelete.length > 0) {
                    // DeleteObjectsCommand accetta max 1000 oggetti
                    for (let i = 0; i < objectsToDelete.length; i += 1000) {
                        const batch = objectsToDelete.slice(i, i + 1000);
                        await client.send(new DeleteObjectCommand({
                            Bucket: bucket,
                            Key: batch[0].Key // DeleteObjectCommand cancella uno alla volta, usiamo loop o DeleteObjectsCommand
                        }));

                        // Nota: DeleteObjectCommand cancella un solo oggetto.
                        // Per cancellarne molti, dovremmo usare DeleteObjectsCommand.
                        // Ma il prompt chiedeva di usare le funzioni esistenti o simili.
                        // Implementiamo un loop parallelo per efficienza.
                        await Promise.all(batch.map(obj => client.send(new DeleteObjectCommand({
                            Bucket: bucket,
                            Key: obj.Key
                        }))));

                        deletedCount += batch.length;
                    }
                }
            }
            continuationToken = response.NextContinuationToken;
        } while (continuationToken);

        console.log(`[Custode] ✅ Eliminati ${deletedCount} file RAW (.flac) per sessione ${sessionId}.`);
        return deletedCount;

    } catch (err: any) {
        console.error(`[Custode] ❌ Errore pulizia RAW sessione ${sessionId}:`, err);
        return 0;
    }
}
