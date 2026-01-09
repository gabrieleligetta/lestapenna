export class AudioChunkSavedEvent {
  constructor(
    public readonly sessionId: string,
    public readonly fileName: string,
    public readonly filePath: string,
    public readonly userId: string,
    public readonly startTime: number, // Timestamp assoluto di inizio registrazione
    public readonly durationMs: number // Durata del chunk
  ) {}
}

export class SessionEndedEvent {
  constructor(
    public readonly sessionId: string,
    public readonly guildId: string
  ) {}
}
