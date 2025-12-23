import sys
import json
import os
from faster_whisper import WhisperModel

# Carichiamo il modello. 
# 'small' è molto più veloce di 'medium' su CPU e ha una ottima accuratezza per l'italiano.
model_size = "medium"

def load_model():
    # Carichiamo il modello una volta per esecuzione
    # NOTA: Per performance ottimali in produzione, questo script dovrebbe rimanere attivo come demone.
    return WhisperModel(model_size, device="cpu", compute_type="int8")

def process_audio(model, audio_file):
    if not os.path.exists(audio_file):
        return {"error": f"File non trovato: {audio_file}"}
    
    segments, info = model.transcribe(audio_file, beam_size=5, language="it")
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
