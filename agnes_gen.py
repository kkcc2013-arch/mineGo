import urllib.request
import json
import os
import time

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
        headers={'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        result = json.loads(response.read().decode('utf-8'))
        image_url = result['data'][0]['url']
        filename = f"agnes_image_{int(time.time())}.png"
        path = os.path.join(DOWNLOAD_DIR, filename)
        urllib.request.urlretrieve(image_url, path)
        return path

def submit_video_task(prompt):
    data = json.dumps({
        'model': 'agnes-video-v2.0',
        'prompt': prompt
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{BASE_URL}/video/generations',
        data=data,
        headers={'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'},
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.loads(response.read().decode('utf-8'))

# Run
img1 = generate_image("Portrait of a cyberpunk city traveler, cinematic lighting, shallow depth of field, 85mm lens, neon reflections, detailed texture")
img2 = generate_image("Steampunk library with flying books, golden hour lighting, magical atmosphere, intricate architecture, cinematic composition")
vid = submit_video_task("Dramatic slow zoom in on a woman's face as she realizes the truth, her smile gradually fades, tears forming in eyes, cinematic lighting, shallow focus, 10 seconds")

print(f"IMG1:{img1}")
print(f"IMG2:{img2}")
print(f"VID_TASK:{vid.get('id')}")
