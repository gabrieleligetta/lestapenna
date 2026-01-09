import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class BackupService {
  private s3Client: S3Client;
  private bucketName: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService
  ) {
    const region = (this.configService.get<string>('OCI_REGION') || '').trim();
    const endpoint = (this.configService.get<string>('OCI_ENDPOINT') || '').trim();
    const accessKeyId = (this.configService.get<string>('OCI_ACCESS_KEY_ID') || '').trim();
    const secretAccessKey = (this.configService.get<string>('OCI_SECRET_ACCESS_KEY') || '').trim();
    this.bucketName = (this.configService.get<string>('OCI_BUCKET_NAME') || '').trim();

    if (!region || !endpoint || !accessKeyId || !secretAccessKey) {
      this.logger.error("[Backup] ⚠️ Variabili d'ambiente OCI mancanti o incomplete!");
    }

    this.logger.log(`[Backup] 🛠️ Inizializzazione S3 Client. Region: ${region}, Endpoint: ${endpoint}`);

    this.s3Client = new S3Client({
      region: region,
      endpoint: endpoint,
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
      },
      forcePathStyle: true
    });
  }

  private getPreferredKey(fileName: string, sessionId?: string): string {
    if (fileName.startsWith('MASTER-') && sessionId) return `recordings/${sessionId}/master/${fileName}`;
    if (fileName.startsWith('FULL-') && sessionId) return `recordings/${sessionId}/full/${fileName}`;
    return sessionId ? `recordings/${sessionId}/chunks/${fileName}` : `recordings/${fileName}`;
  }

  private async findS3Key(fileName: string, sessionId?: string): Promise<string | null> {
    const candidates: string[] = [];

    if (sessionId) {
      if (fileName.startsWith('MASTER-')) candidates.push(`recordings/${sessionId}/master/${fileName}`);
      else if (fileName.startsWith('FULL-')) candidates.push(`recordings/${sessionId}/full/${fileName}`);
      else candidates.push(`recordings/${sessionId}/chunks/${fileName}`);
      candidates.push(`recordings/${sessionId}/${fileName}`);
    }
    candidates.push(`recordings/${fileName}`);

    for (const key of candidates) {
      try {
        await this.s3Client.send(new HeadObjectCommand({ Bucket: this.bucketName, Key: key }));
        return key;
      } catch (err: any) {
        if (err.name !== 'NotFound' && err.$metadata?.httpStatusCode !== 404) {
          this.logger.warn(`[Backup] ⚠️ Errore check ${key}: ${err.message}`);
        }
      }
    }
    return null;
  }

  async uploadToOracle(filePath: string, fileName: string, sessionId?: string, customKey?: string): Promise<string | null> {
    try {
      if (!customKey) {
        const existingKey = await this.findS3Key(fileName, sessionId);
        if (existingKey) {
          this.logger.log(`[Backup] ⏩ Salto upload, file già presente su Oracle: ${existingKey}`);
          return fileName;
        }
      }

      if (!fs.existsSync(filePath)) {
        this.logger.error(`[Backup] ❌ Impossibile caricare: file locale non trovato ${filePath}`);
        return null;
      }

      const fileContent = fs.readFileSync(filePath);
      const targetKey = customKey ? customKey : this.getPreferredKey(fileName, sessionId);
      
      const extension = path.extname(fileName).toLowerCase();
      const contentType = extension === '.ogg' ? 'audio/ogg' : 
                        extension === '.mp3' ? 'audio/mpeg' : 
                        extension === '.json' ? 'application/json' :
                        'audio/x-pcm';

      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: targetKey,
        Body: fileContent,
        ContentType: contentType
      });

      await this.s3Client.send(command);
      this.logger.log(`[Backup] ☁️ Backup completato su Oracle: ${targetKey}`);
      return fileName;
    } catch (err) {
      this.logger.error(`[Backup] ❌ Errore backup su Oracle per ${fileName}:`, err);
      return null;
    }
  }

  async downloadFromOracle(fileName: string, localPath: string, sessionId?: string): Promise<boolean> {
    try {
      const key = await this.findS3Key(fileName, sessionId);
      if (!key) {
        this.logger.error(`[Backup] ❌ File non trovato nel Cloud (né in sessione né legacy): ${fileName}`);
        return false;
      }

      const command = new GetObjectCommand({ Bucket: this.bucketName, Key: key });
      const response = await this.s3Client.send(command);
      
      if (response.Body) {
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const stream = response.Body as Readable;
        const fileStream = fs.createWriteStream(localPath);
        
        return new Promise((resolve, reject) => {
          stream.pipe(fileStream)
            .on('error', (err) => {
              this.logger.error(`[Backup] ❌ Errore scrittura file locale ${fileName}:`, err);
              reject(err);
            })
            .on('finish', () => {
              this.logger.log(`[Backup] 📥 File ripristinato da Oracle: ${fileName}`);
              resolve(true);
            });
        });
      }
      return false;
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
          this.logger.error(`[Backup] ❌ File non trovato nel Cloud: ${fileName}`);
      } else {
          this.logger.error(`[Backup] ❌ Errore download da Oracle per ${fileName}:`, err);
      }
      return false;
    }
  }

  async getPresignedUrl(fileName: string, sessionId?: string, expiresInSeconds: number = 3600): Promise<string | null> {
    try {
      const key = await this.findS3Key(fileName, sessionId);
      
      if (!key) {
        this.logger.warn(`[Backup] ⚠️ Richiesto URL per file non trovato: ${fileName}`);
      }

      const targetKey = key || this.getPreferredKey(fileName, sessionId);
      
      const command = new GetObjectCommand({ Bucket: this.bucketName, Key: targetKey });
      const url = await getSignedUrl(this.s3Client, command, { expiresIn: expiresInSeconds });
      
      if (key) {
          this.logger.log(`[Backup] 🔗 URL generato per ${key}`);
      }
      return url;
    } catch (err) {
      this.logger.error(`[Backup] ❌ Errore generazione URL firmato per ${fileName}:`, err);
      return null;
    }
  }

  async wipeBucket(): Promise<number> {
    let totalDeleted = 0;
    const prefixes = ['recordings/', 'logs/', 'transcripts/']; 

    this.logger.log(`[Backup] 🧹 Inizio svuotamento COMPLETO bucket: ${this.bucketName}...`);

    for (const prefix of prefixes) {
        let continuationToken: string | undefined = undefined;
        this.logger.log(`[Backup] 🧹 Scansione prefisso: '${prefix}'...`);

        do {
            const listCommand: ListObjectsV2Command = new ListObjectsV2Command({
                Bucket: this.bucketName,
                Prefix: prefix,
                ContinuationToken: continuationToken
            });

            const listResponse: ListObjectsV2CommandOutput = await this.s3Client.send(listCommand);
            
            if (!listResponse.Contents || listResponse.Contents.length === 0) {
                break;
            }

            const deletePromises = listResponse.Contents
                .filter((obj: any) => obj.Key)
                .map(async (obj: any) => {
                    try {
                        await this.s3Client.send(new DeleteObjectCommand({
                            Bucket: this.bucketName,
                            Key: obj.Key!
                        }));
                        this.logger.log(`[Backup] 🗑️ Eliminato: ${obj.Key}`);
                        totalDeleted++;
                    } catch (e) {
                        this.logger.error(`[Backup] Errore cancellazione ${obj.Key}:`, e);
                    }
                });

            await Promise.all(deletePromises);
            continuationToken = listResponse.NextContinuationToken;

        } while (continuationToken);
    }
    
    this.logger.log(`[Backup] ✅ Eliminati ${totalDeleted} oggetti totali dal Cloud.`);
    return totalDeleted;
  }
}
