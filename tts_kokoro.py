#!/usr/bin/env python3
"""Kokoro TTS wrapper for Vocal Nexus server."""
import sys
import os
import io
import soundfile as sf
import numpy as np

# Suppress warnings
os.environ["TOKENIZERS_PARALLELISM"] = "false"

def generate_wav(text, voice="ef_dora", speed=1.0):
    """Generate WAV audio from text using Kokoro TTS."""
    from kokoro import KPipeline
    
    pipeline = KPipeline(lang_code="e")
    audio_chunks = []
    
    for gs, ps, audio in pipeline(text, voice=voice, speed=speed):
        audio_chunks.append(audio)
    
    if not audio_chunks:
        return None
    
    combined = np.concatenate(audio_chunks)
    
    buf = io.BytesIO()
    sf.write(buf, combined, 24000, format="WAV")
    return buf.getvalue()

if __name__ == "__main__":
    text = sys.argv[1] if len(sys.argv) > 1 else "Prueba"
    voice = sys.argv[2] if len(sys.argv) > 2 else "ef_dora"
    
    wav_data = generate_wav(text, voice)
    if wav_data:
        sys.stdout.buffer.write(wav_data)
    else:
        sys.exit(1)
