import sys
import json
import os
from faster_whisper import WhisperModel

# Cambia da "medium" a "small" per velocità
model_size = "medium"

def load_model():
    # Ottimizzazione CPU ARM (M1/Oracle A1):
    # cpu_threads=4: Usa tutti e 3 i core della tua futura istanza OCI uno lo lasciamo per node.
    # num_workers=1: Evita parallelismi interni che saturano la memoria su file singoli.
    return WhisperModel(
        model_size, 
        device="cpu", 
        compute_type="int8", 
        cpu_threads=3,
        num_workers=1
    )

def process_audio(model, audio_file):
    if not os.path.exists(audio_file):
        return {"error": f"File non trovato: {audio_file}"}
    
    # OTTIMIZZAZIONI QUI:
    # 1. vad_filter=True: Salta i silenzi (enorme risparmio di tempo)
    # 2. beam_size=1: Modalità "greedy", molto più veloce.
    # 3. word_timestamps=True: Migliora la precisione dei timestamp
    segments, info = model.transcribe(
        audio_file, 
        beam_size=3,            # Cambia da 2 a 1 per velocità pura
        language="it",
        vad_filter=True,        # Fondamentale: ignora i silenzi
        vad_parameters=dict(min_silence_duration_ms=500), # Ignora pause > 0.5s
        condition_on_previous_text=False, # Evita allucinazioni e loop in alcuni casi
        word_timestamps=True    # Abilita timestamp precisi per segmentazione
    )
    
    output_segments = []
    for segment in segments:
        output_segments.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text.strip()
        })

    return {"segments": output_segments}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Manca il file audio o l'opzione --daemon"}))
        sys.exit(1)

    if sys.argv[1] == "--daemon":
        try:
            model = load_model()
            print("READY", flush=True)
            for line in sys.stdin:
                audio_path = line.strip()
                if not audio_path:
                    continue
                try:
                    result = process_audio(model, audio_path)
                    print(json.dumps(result), flush=True)
                except Exception as e:
                    print(json.dumps({"error": str(e)}), flush=True)
        except Exception as e:
            print(json.dumps({"error": "Failed to initialize model: " + str(e)}), flush=True)
            sys.exit(1)
    else:
        # Modalità classica a riga di comando (per retrocompatibilità o test)
        audio_file = sys.argv[1]
        try:
            model = load_model()
            result = process_audio(model, audio_file)
            if "error" in result:
                print(json.dumps(result))
                sys.exit(1)
            print(json.dumps(result))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)
