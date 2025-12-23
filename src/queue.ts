import { Queue } from 'bullmq';

// Configurazione Coda
// Assicurati che l'host corrisponda al nome del servizio nel docker-compose (es. 'redis')
export const audioQueue = new Queue('audio-processing', { 
    connection: { 
        host: process.env.REDIS_HOST || 'redis', 
        port: parseInt(process.env.REDIS_PORT || '6379') 
    } 
});
