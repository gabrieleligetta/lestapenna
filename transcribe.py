import sys
import json
import os
from faster_whisper import WhisperModel

# Cambia da "medium" a "small" per velocità
model_size = "small"

def load_model():
    # Ottimizzazione CPU ARM (M1/Oracle A1):
    # cpu_threads=4: Usa tutti e 4 i core della tua futura istanza OCI.
    # num_workers=1: Evita parallelismi interni che saturano la memoria su file singoli.
    return WhisperModel(
        model_size, 
        device="cpu", 
        compute_type="int8", 
        cpu_threads=4, 
        num_workers=1
    )

def process_audio(model, audio_file):
    if not os.path.exists(audio_file):
        return {"error": f"File non trovato: {audio_file}"}
    
    # OTTIMIZZAZIONI QUI:
    # 1. vad_filter=True: Salta i silenzi (enorme risparmio di tempo)
    # 2. beam_size=1: Modalità "greedy", molto più veloce.
    segments, info = model.transcribe(
        audio_file, 
        beam_size=1,            # Cambia da 2 a 1 per velocità pura
        language="it",
        vad_filter=True,        # Fondamentale: ignora i silenzi
        vad_parameters=dict(min_silence_duration_ms=500), # Ignora pause > 0.5s
        condition_on_previous_text=False # Evita allucinazioni e loop in alcuni casi
    )
    
    full_text = " ".join([segment.text for segment in segments])
    return {"text": full_text.strip()}

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
