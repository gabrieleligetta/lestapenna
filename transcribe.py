import sys
from faster_whisper import WhisperModel

# Prendiamo il file audio dagli argomenti
if len(sys.argv) < 2:
    print("Errore: Manca il file audio")
    sys.exit(1)

audio_file = sys.argv[1]

# Carichiamo il modello. 
# 'medium' è un buon compromesso. 'small' è più veloce. 'large-v3' è il più preciso.
# Su Oracle ARM useremo "int8" per andare veloci.
model_size = "medium"

try:
    # Run on CPU with INT8 quantization
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    
    segments, info = model.transcribe(audio_file, beam_size=5, language="it")
    
    full_text = ""
    for segment in segments:
        full_text += segment.text + " "
        
    print(full_text.strip())

except Exception as e:
    print(f"Errore Trascrizione: {e}")
    sys.exit(1)
