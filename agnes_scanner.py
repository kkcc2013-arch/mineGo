import urllib.request
import json
import time
import os
import datetime

API_KEY = 'sk-1ie6wgGDFqZU0a5Pt8nH2oPyVMpR18GJOJyww1AFDHx4qdix'
BASE_URL = 'https://apihub.agnes-ai.com/v1'
DOWNLOAD_DIR = '/tmp/agnes-ai'

if not os.path.exists(DOWNLOAD_DIR):
    os.makedirs(DOWNLOAD_DIR)

def generate_image(prompt):
    data = json.dumps({
        'model': 'agnes-image-2.1-flash',
        'prompt': prompt,
        'size': '1024x1024',
        'n': 1
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{BASE_URL}/images/generations',
        data=data,
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        result = json.loads(response.read().decode('utf-8'))
        image_url = result['data'][0]['url']
        filename = f"agnes_image_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{os.urandom(4).hex()}.png"
        path = os.path.join(DOWNLOAD_DIR, filename)
        with urllib.request.urlopen(image_url, timeout=60) as img_res:
            with open(path, 'wb') as f:
                f.write(img_res.read())
        return path

def submit_video_task(prompt):
    data = json.dumps({
        'model': 'agnes-video-v2.0',
        'prompt': prompt
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{BASE_URL}/video/generations',
        data=data,
        headers={
            'Authorization': f'Bearer {API_KEY}',
            'Content-Type': 'application/json'
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print(f"Video API error: {e.code} - {e.read().decode()}")
        return None

# Generate images
img_prompts = [
    "A cinematic portrait of a cyberpunk girl, neon lights reflecting on wet skin, high detail, masterpiece, 8k",
    "A watercolor painting of a peaceful misty mountain village in China, traditional brush strokes, ethereal atmosphere, high quality"
]

results = []
for p in img_prompts:
    try:
        path = generate_image(p)
        results.append({'prompt': p, 'path': path})
    except Exception as e:
        print(f"Image gen failed: {e}")

# Video task
video_prompt = "Cinematic drone shot flying over a futuristic city at night with flying vehicles and glowing neon signs, high resolution"
video_task = submit_video_task(video_prompt)

print("--- RESULTS ---")
for r in results:
    print(f"Prompt: {r['prompt']}\nMEDIA:{r['path']}\n")
if video_task:
    print(f"Video Prompt: {video_prompt}\nTask ID: {video_task.get('id')}")
