import sys
import os
import json
import argparse
import logging

# Configura logging su STDERR per non sporcare il JSON su STDOUT
logging.basicConfig(
    level=logging.INFO,
    format='[Python-Whisper] %(message)s',
    stream=sys.stderr
)
logger = logging.getLogger()

# Importiamo solo faster_whisper, niente torch!
try:
    from faster_whisper import WhisperModel
except ImportError:
    logger.error("ERRORE CRITICO: 'faster_whisper' non installato.")
    sys.exit(1)

def print_progress(current, total):
    """Disegna la barra di avanzamento su STDERR"""
    if total <= 0: return
    percentage = int((current / total) * 100)
    if percentage > 100: percentage = 100

    bar_length = 20
    filled_length = int(bar_length * percentage // 100)
    bar = '█' * filled_length + '░' * (bar_length - filled_length)

    # \r serve per sovrascrivere la riga (effetto animazione)
    sys.stderr.write(f"\r[Python-Whisper] ⏳ Elaborazione: [{bar}] {percentage}%")
    sys.stderr.flush()

def transcribe_file(model, audio_path):
    if not os.path.exists(audio_path):
        return {"error": f"File not found: {audio_path}"}

    logger.info(f"🗣️  Inizio trascrizione: {os.path.basename(audio_path)}")

    try:
        # beam_size=5 è lo standard per alta qualità
        segments_generator, info = model.transcribe(audio_path, beam_size=1, language="it")

        duration = info.duration
        logger.info(f"📏 Durata audio rilevata: {duration:.2f}s")

        segment_list = []
        full_text = []

        # Iteriamo sul generatore per estrarre i segmenti e aggiornare la barra
        for segment in segments_generator:
            segment_data = {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip()
            }
            segment_list.append(segment_data)
            full_text.append(segment.text.strip())

            # Aggiorna barra
            print_progress(segment.end, duration)

        # A capo dopo la barra
        sys.stderr.write("\n")
        logger.info(f"✅ Completato. Segmenti generati: {len(segment_list)}")

        return {
            "text": " ".join(full_text),
            "segments": segment_list,
            "language": info.language,
            "duration": info.duration
        }

    except Exception as e:
        logger.error(f"❌ Errore durante trascrizione: {e}")
        return {"error": str(e)}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path", nargs="?", help="Path to file (optional in daemon mode)")
    parser.add_argument("--daemon", action="store_true", help="Run in daemon mode")
    parser.add_argument("--model", default="medium", help="Whisper model size")
    args = parser.parse_args()

    # Rilevamento Device con metodo "Try-Catch" (Non serve torch)
    logger.info(f"Tentativo caricamento modello '{args.model}' su GPU...")

    model = None
    try:
        # 1. Proviamo a forzare CUDA e float16 (Massima velocità)
        model = WhisperModel(args.model, device="cuda", compute_type="float16")
        logger.info("✅ Modello caricato su GPU (CUDA) - Modalità Turbo.")
    except Exception as e:
        logger.warning(f"⚠️ Impossibile usare GPU: {e}")
        logger.info("🔄 Passaggio a CPU (int8)...")
        try:
            # 2. Fallback su CPU e int8 (Compatibilità totale)
            model = WhisperModel(args.model, device="cpu", compute_type="int8")
            logger.info("✅ Modello caricato su CPU.")
        except Exception as e_cpu:
            logger.error(f"❌ ERRORE CRITICO caricamento modello: {e_cpu}")
            sys.exit(1)

    if args.daemon:
        logger.info("🚀 Avvio modalità DAEMON. In attesa di input su STDIN...")
        print("READY", flush=True) # Segnale per Node.js

        for line in sys.stdin:
            audio_path = line.strip()
            if not audio_path: continue

            result = transcribe_file(model, audio_path)

            # Output JSON puro su STDOUT
            print(json.dumps(result, ensure_ascii=False), flush=True)
            logger.info("In attesa del prossimo file...")
    else:
        if not args.audio_path:
            logger.error("Errore: audio_path richiesto se non in modalità daemon")
            sys.exit(1)

        result = transcribe_file(model, args.audio_path)
        print(json.dumps(result, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    # Forza UTF-8 per evitare errori di encoding su log/json
    if sys.stdout.encoding != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')
    if sys.stderr.encoding != 'utf-8':
        sys.stderr.reconfigure(encoding='utf-8')

    main()
