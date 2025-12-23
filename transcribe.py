import sys
import json
from faster_whisper import WhisperModel

# Prendiamo il file audio dagli argomenti
if len(sys.argv) < 2:
    print(json.dumps({"error": "Manca il file audio"}))
    sys.exit(1)

audio_file = sys.argv[1]

# Carichiamo il modello. 
# 'small' è molto più veloce di 'medium' su CPU e ha una buona accuratezza per l'italiano.
model_size = "medium"

try:
    # Run on CPU with INT8 quantization
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    
    segments, info = model.transcribe(audio_file, beam_size=5, language="it")
    
    full_text = ""
    for segment in segments:
        full_text += segment.text + " "
        
    print(json.dumps({"text": full_text.strip()}))

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
