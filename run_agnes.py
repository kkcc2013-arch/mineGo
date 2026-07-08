import urllib.request
import json
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
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"agnes_image_{timestamp}.png"
        filepath = os.path.join(DOWNLOAD_DIR, filename)
        
        with urllib.request.urlopen(image_url, timeout=60) as img_resp:
            with open(filepath, 'wb') as f:
                f.write(img_resp.read())
        return filepath

def submit_video(prompt):
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

    with urllib.request.urlopen(req, timeout=300) as response:
        result = json.loads(response.read().decode('utf-8'))
        return result['id']

# 执行生成任务
try:
    img1 = generate_image("A majestic cyberpunk city street at night, neon lights reflecting on wet ground, cinematic lighting, 8k resolution, highly detailed, futuristic aesthetic")
    img2 = generate_image("A serene watercolor painting of a traditional Chinese mountain landscape with a lone pine tree on a cliff, soft misty atmosphere, ethereal, masterpiece")
    task_id = submit_video("Cinematic drone shot over a neon-lit city at night, rain on the lens, cyberpunk aesthetic, motion blur, fast-paced")
    
    print(f"IMG1:{img1}")
    print(f"IMG2:{img2}")
    print(f"TASK_ID:{task_id}")
except Exception as e:
    print(f"ERROR:{e}")
