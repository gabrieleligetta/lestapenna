import sys
import whisper
import argparse
import os
import torch
import warnings
import json
import re
import io

# Ignora warning inutili di PyTorch/Whisper
warnings.filterwarnings("ignore")

def log(message):
    """Stampa log formattati per Node.js"""
    # Usiamo sys.__stdout__ per assicurarci di scrivere sul terminale reale
    # anche se abbiamo reindirizzato stdout altrove
    print(f"[Python-Whisper] {message}", file=sys.__stdout__, flush=True)

class ProgressCapture(io.StringIO):
    """
    Classe magica che intercetta l'output 'verbose' di Whisper.
    Invece di stampare righe di testo, calcola la percentuale e stampa la barra.
    """
    def __init__(self, total_duration_secs):
        super().__init__()
        self.total_duration_secs = total_duration_secs
        self.last_percent = -1
        # Regex per catturare il timestamp finale del segmento: "00:00.000 --> 00:05.000"
        self.timestamp_pattern = re.compile(r"--> (\d{2}):(\d{2})\.(\d{3})")

    def write(self, text):
        # Cerca il timestamp nell'output di Whisper
        match = self.timestamp_pattern.search(text)
        if match and self.total_duration_secs > 0:
            minutes = int(match.group(1))
            seconds = int(match.group(2))
            current_seconds = (minutes * 60) + seconds

            # Calcola percentuale
            percent = int((current_seconds / self.total_duration_secs) * 100)
            if percent > 100: percent = 100

            # Aggiorna la barra solo se la % è cambiata (per non intasare i log)
            if percent > self.last_percent:
                bar_length = 20
                filled_length = int(bar_length * percent / 100)
                bar = '█' * filled_length + '░' * (bar_length - filled_length)

                # Stampa la barra sul terminale VERO
                print(f"[Python-Whisper] ⏳ Trascrizione: [{bar}] {percent}%", file=sys.__stdout__, flush=True)
                self.last_percent = percent

    def flush(self):
        pass

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", help="Path to the audio file")
    parser.add_argument("--model", default="medium", help="Whisper model size")
    args = parser.parse_args()

    audio_path = args.audio_path
    model_name = args.model

    if not os.path.exists(audio_path):
        log(f"❌ ERRORE: File non trovato: {audio_path}")
        sys.exit(1)

    # 1. Calcolo Durata Totale
    total_duration = 0
    try:
        log("🎧 Analisi durata audio...")
        # Carichiamo solo l'audio leggero per vedere quanto dura
        audio = whisper.load_audio(audio_path)
        total_duration = len(audio) / whisper.audio.SAMPLE_RATE
        m = int(total_duration // 60)
        s = int(total_duration % 60)
        log(f"📏 Durata rilevata: {m}m {s}s")
    except Exception as e:
        log(f"⚠️ Impossibile calcolare durata: {e}")

    # 2. Caricamento Modello
    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"💻 Dispositivo: {device.upper()}")

    try:
        model_path = os.path.expanduser(f"~/.cache/whisper/{model_name}.pt")
        if not os.path.exists(model_path) and not os.path.exists(f"/root/.cache/whisper/{model_name}.pt"):
            log(f"⏳ Download modello '{model_name}' in corso (richiede tempo)...")

        model = whisper.load_model(model_name, device=device)
        log("✅ Modello caricato in memoria.")

        # 3. Trascrizione con Intercettazione Output
        log(f"🗣️  Avvio trascrizione...")

        # Salviamo lo stdout originale
        original_stdout = sys.stdout

        try:
            # Reindirizziamo stdout alla nostra classe che disegna le barre
            sys.stdout = ProgressCapture(total_duration)

            # verbose=True è FONDAMENTALE: fa stampare a Whisper i timestamp che noi catturiamo
            result = model.transcribe(
                audio_path,
                verbose=True,
                fp16=False,
                language="it"
            )
        finally:
            # Ripristiniamo stdout o non vedremo il JSON finale!
            sys.stdout = original_stdout

        segment_count = len(result['segments'])
        log(f"✅ Trascrizione completata! Generati {segment_count} segmenti.")

        # Output JSON finale per Node.js
        print(json.dumps(result, ensure_ascii=False), flush=True)

    except Exception as e:
        # Ripristina stdout in caso di errore per vedere il log
        sys.stdout = sys.__stdout__
        log(f"❌ ERRORE CRITICO WHISPER: {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
