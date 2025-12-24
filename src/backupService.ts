import 'dotenv/config';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

let _s3Client: S3Client | null = null;

function getS3Client(): S3Client {
    if (!_s3Client) {
        const region = (process.env.OCI_REGION || '').trim();
        const endpoint = (process.env.OCI_ENDPOINT || '').trim();
        const accessKeyId = (process.env.OCI_ACCESS_KEY_ID || '').trim();
        const secretAccessKey = (process.env.OCI_SECRET_ACCESS_KEY || '').trim();

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

const getBucketName = () => (process.env.OCI_BUCKET_NAME || '').trim();

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
        const sessionKey = `recordings/${sessionId}/${fileName}`;
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
    const legacyKey = `recordings/${fileName}`;
    try {
        await getS3Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: legacyKey }));
        return legacyKey;
    } catch (err: any) {
        if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
            console.error(`[Custode] ❌ Errore verifica existence per ${legacyKey}:`, err);
        }
    }

    return null;
}

/**
 * Verifica se un file esiste nel bucket OCI.
 */
export async function checkFileExists(fileName: string, sessionId?: string): Promise<boolean> {
    const key = await findS3Key(fileName, sessionId);
    return key !== null;
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
                          extension === '.json' ? 'application/json' :
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
export async function getPresignedUrl(fileName: string, sessionId?: string, expiresInSeconds: number = 3600): Promise<string | null> {
    try {
        // Cerchiamo dove si trova il file (legacy o nuova struttura)
        const key = await findS3Key(fileName, sessionId);
        
        if (!key) {
            // Se non esiste, assumiamo che sarà caricato nel percorso preferito
            // Questo è utile se stiamo generando l'URL per un file appena caricato ma non ancora indicizzato
            // o se vogliamo forzare il percorso nuovo.
            // Tuttavia, per sicurezza, ritorniamo null se non lo troviamo, 
            // perché getPresignedUrl su una chiave inesistente genererebbe comunque un link (che darebbe 404).
            console.warn(`[Custode] ⚠️ Richiesto URL per file non trovato: ${fileName}`);
            
            // Fallback: proviamo a generare l'URL per dove DOVREBBE essere
            const targetKey = getPreferredKey(fileName, sessionId);
            console.log(`[Custode] 🔗 Genero URL per percorso previsto: ${targetKey}`);
            
            const command = new GetObjectCommand({
                Bucket: getBucketName(),
                Key: targetKey
            });
            
            return await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
        }

        const command = new GetObjectCommand({
            Bucket: getBucketName(),
            Key: key
        });

        const url = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSeconds });
        console.log(`[Custode] 🔗 URL generato per ${key}`);
        return url;

    } catch (err) {
        console.error(`[Custode] ❌ Errore generazione URL firmato per ${fileName}:`, err);
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
            const listCommand = new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: continuationToken
            });

            const listResponse = await client.send(listCommand);
            
            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                break;
            }

            const deletePromises = listResponse.Contents
                .filter(obj => obj.Key)
                .map(async (obj) => {
                    try {
                        await client.send(new DeleteObjectCommand({
                            Bucket: bucket,
                            Key: obj.Key
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
