#!/usr/bin/env python3
"""
抓取 YouMind GPT Image 2 提示词数据
"""
import json
import re
import time
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException

def setup_driver():
    """设置 Chrome WebDriver"""
    options = Options()
    options.add_argument('--headless')
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--window-size=1920,1080')
    options.add_argument('--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
    return webdriver.Chrome(options=options)

def extract_prompts_from_page(driver):
    """从当前页面提取提示词数据"""
    prompts = []
    
    # 执行 JavaScript 提取数据
    script = """
    const results = [];
    const seen = new Set();
    
    // 查找所有提示词卡片容器
    document.querySelectorAll('a[href*="/prompts/"]').forEach(link => {
        const href = link.getAttribute('href') || '';
        const fullHref = link.href || '';
        
        // 查找父容器
        let container = link.closest('[class*="card"]') || link.parentElement?.parentElement?.parentElement?.parentElement;
        if (!container) return;
        
        // 提取提示词文本
        const promptEl = container.querySelector('.font-mono, [class*="whitespace-pre-wrap"]');
        const promptText = promptEl?.textContent?.trim() || '';
        
        if (promptText.length < 20) return;
        
        // 提取标题
        const titleEl = container.querySelector('img');
        const title = titleEl?.alt || '';
        
        // 提取图片 URL
        const imgUrl = titleEl?.src || '';
        
        // 提取作者
        const authorLink = container.querySelector('a[href*="/u/"]');
        const author = authorLink?.textContent?.trim() || '';
        
        // 提取日期
        const dateEl = container.querySelector('time') || Array.from(container.querySelectorAll('*')).find(el => {
            const text = el.textContent?.trim() || '';
            return text.match(/\\d{4}年\\d{1,2}月\\d{1,2}日/) || text.match(/\\d+小时前/) || text.match(/昨天|前天/);
        });
        const date = dateEl?.textContent?.trim() || '';
        
        const key = promptText.substring(0, 100);
        if (seen.has(key)) return;
        seen.add(key);
        
        results.push({
            url: fullHref,
            title: title,
            prompt: promptText,
            author: author,
            date: date,
            image_url: imgUrl
        });
    });
    
    return results;
    """
    
    try:
        results = driver.execute_script(script)
        if results:
            prompts.extend(results)
    except Exception as e:
        print(f"提取数据时出错: {e}")
    
    return prompts

def scroll_and_load(driver, target_count=500, max_scrolls=100):
    """滚动页面加载更多数据"""
    all_prompts = []
    seen_prompts = set()
    
    last_height = driver.execute_script("return document.body.scrollHeight")
    scroll_count = 0
    no_new_data_count = 0
    
    while len(all_prompts) < target_count and scroll_count < max_scrolls:
        # 提取当前页面的数据
        new_prompts = extract_prompts_from_page(driver)
        
        # 添加新数据
        for p in new_prompts:
            key = p.get('prompt', '')[:100]
            if key and key not in seen_prompts:
                seen_prompts.add(key)
                all_prompts.append(p)
        
        print(f"已提取 {len(all_prompts)} 条提示词 (滚动 {scroll_count + 1} 次)")
        
        if len(all_prompts) >= target_count:
            break
        
        # 滚动页面
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(2)  # 等待加载
        
        # 检查是否到达页面底部
        new_height = driver.execute_script("return document.body.scrollHeight")
        if new_height == last_height:
            no_new_data_count += 1
            if no_new_data_count >= 3:
                print("已到达页面底部，无法加载更多数据")
                break
        else:
            no_new_data_count = 0
            last_height = new_height
        
        scroll_count += 1
    
    return all_prompts

def save_to_jsonl(prompts, output_path):
    """保存为 JSONL 格式"""
    with open(output_path, 'w', encoding='utf-8') as f:
        for p in prompts:
            # 标准化数据格式
            item = {
                'prompt': p.get('prompt', ''),
                'title': p.get('title', ''),
                'image_url': p.get('image_url', ''),
                'author': p.get('author', ''),
                'source_url': p.get('url', ''),
                'category': 'gpt-image-2',
                'tags': []
            }
            f.write(json.dumps(item, ensure_ascii=False) + '\n')
    print(f"已保存 {len(prompts)} 条数据到 {output_path}")

def main():
    # 目标 URL
    url = "https://youmind.com/zh-CN/gpt-image-2-prompts/explore?sortBy=views&sortOrder=desc"
    output_path = "/data/Image-Prompts/data/exports/youmind.jsonl"
    
    print(f"开始抓取: {url}")
    
    # 设置 WebDriver
    driver = setup_driver()
    
    try:
        # 访问页面
        driver.get(url)
        time.sleep(5)  # 等待页面加载
        
        # 滚动并提取数据
        prompts = scroll_and_load(driver, target_count=500, max_scrolls=50)
        
        # 保存数据
        save_to_jsonl(prompts, output_path)
        
    finally:
        driver.quit()

if __name__ == "__main__":
    main()
