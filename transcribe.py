#!/usr/bin/env python3
"""
Transcribes an audio file using OpenAI Whisper API.
Usage: python3 transcribe.py <audio_path>
Output: JSON { transcript, segments:[{start,end,text}], language }
"""
import sys
import os
import json
import requests

def transcribe(audio_path):
    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        print(json.dumps({'transcript': '', 'segments': [], 'language': 'unknown'}))
        return

    try:
        with open(audio_path, 'rb') as f:
            response = requests.post(
                'https://api.openai.com/v1/audio/transcriptions',
                headers={'Authorization': f'Bearer {api_key}'},
                files={'file': (os.path.basename(audio_path), f, 'audio/mpeg')},
                data={
                    'model': 'whisper-1',
                    'response_format': 'verbose_json',
                    'timestamp_granularities[]': 'segment',
                },
                timeout=120
            )

        if not response.ok:
            print(json.dumps({'transcript': '', 'segments': [], 'language': 'unknown'}))
            return

        data = response.json()
        segments = [
            {'start': s['start'], 'end': s['end'], 'text': s['text'].strip()}
            for s in data.get('segments', [])
        ]
        print(json.dumps({
            'transcript': data.get('text', ''),
            'segments':   segments,
            'language':   data.get('language', 'unknown'),
        }))

    except Exception as e:
        sys.stderr.write(f'transcribe error: {e}\n')
        print(json.dumps({'transcript': '', 'segments': [], 'language': 'unknown'}))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'transcript': '', 'segments': [], 'language': 'unknown'}))
    else:
        transcribe(sys.argv[1])
