import sys
import json
import os
import time
from faster_whisper import WhisperModel

# Cambia da "medium" a "small" per velocità se necessario, ma qui teniamo medium come da config
model_size = "medium"

def log(message):
    """Scrive messaggi di log su stderr per non interferire con il JSON su stdout"""
    print(f"[Python-Whisper] {message}", file=sys.stderr, flush=True)

def load_model():
    log(f"⏳ Caricamento modello '{model_size}' in corso... (potrebbe scaricare dati se non in cache)")
    start_time = time.time()
    
    # Ottimizzazione CPU ARM (M1/Oracle A1):
    model = WhisperModel(
        model_size, 
        device="cpu", 
        compute_type="int8", 
        cpu_threads=4,
        num_workers=1
    )
    
    elapsed = time.time() - start_time
    log(f"✅ Modello caricato in {elapsed:.2f}s.")
    return model

def process_audio(model, audio_file):
    if not os.path.exists(audio_file):
        log(f"❌ Errore: File non trovato -> {audio_file}")
        return {"error": f"File non trovato: {audio_file}"}
    
    log(f"🗣️  Inizio trascrizione file: {audio_file}")
    start_time = time.time()

    # OTTIMIZZAZIONI QUI:
    segments, info = model.transcribe(
        audio_file, 
        beam_size=1,            # Greedy mode per velocità
        language="it",
        vad_filter=True,        # Ignora i silenzi
        vad_parameters=dict(min_silence_duration_ms=500), 
        condition_on_previous_text=False, 
        word_timestamps=True    
    )
    
    output_segments = []
    count = 0
    for segment in segments:
        # Log ogni 20 segmenti per mostrare che è vivo
        count += 1
        if count % 20 == 0:
            log(f"   ...elaborati {count} segmenti...")
            
        output_segments.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip()
        })

    elapsed = time.time() - start_time
    log(f"✅ Trascrizione completata in {elapsed:.2f}s. Segmenti totali: {len(output_segments)}")

    return {"segments": output_segments}

if __name__ == "__main__":
    # Forza stdout e stderr a essere unbuffered (anche se usiamo flush=True)
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)

    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        try:
            log("Avvio modalità DAEMON. Inizializzazione modello...")
            model = load_model()
            print("READY", flush=True)
            log("Pronto a ricevere comandi.")
            
            for line in sys.stdin:
                audio_path = line.strip()
                if not audio_path:
                    continue
                
                log(f"Ricevuta richiesta per: {audio_path}")
                try:
                    result = process_audio(model, audio_path)
                    print(json.dumps(result), flush=True)
                except Exception as e:
                    log(f"❌ Eccezione durante trascrizione: {str(e)}")
                    print(json.dumps({"error": str(e)}), flush=True)
        except Exception as e:
            log(f"❌ CRITICAL: Failed to initialize model: {str(e)}")
            print(json.dumps({"error": "Failed to initialize model: " + str(e)}), flush=True)
            sys.exit(1)
    else:
        # Modalità one-shot (CLI)
        if len(sys.argv) < 2:
            print(json.dumps({"error": "Manca il file audio o l'opzione --daemon"}))
            sys.exit(1)
            
        audio_file = sys.argv[1]
        try:
            model = load_model()
            result = process_audio(model, audio_file)
            print(json.dumps(result), flush=True)
        except Exception as e:
            log(f"❌ Error: {str(e)}")
            print(json.dumps({"error": str(e)}), flush=True)
            sys.exit(1)
