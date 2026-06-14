#!/usr/bin/env python3
"""
使用 Playwright 抓取 YouMind GPT Image 2 提示词数据
"""
import json
import asyncio
import os

async def scrape_youmind():
    from playwright.async_api import async_playwright
    
    output_path = "/data/Image-Prompts/data/exports/youmind.jsonl"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    all_prompts = []
    seen_prompts = set()
    
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # 设置用户代理
        await page.set_extra_http_headers({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        })
        
        # 访问页面
        url = "https://youmind.com/zh-CN/gpt-image-2-prompts/explore?sortBy=views&sortOrder=desc"
        print(f"正在访问: {url}")
        await page.goto(url, wait_until='networkidle', timeout=60000)
        await page.wait_for_timeout(3000)
        
        # 滚动并提取数据
        scroll_count = 0
        max_scrolls = 100
        target_count = 500
        no_new_data_count = 0
        
        while len(all_prompts) < target_count and scroll_count < max_scrolls:
            # 提取当前页面的数据
            prompts = await page.evaluate('''() => {
                const results = [];
                const seen = new Set();
                
                // 查找所有提示词卡片
                document.querySelectorAll('a[href*="/prompts/"]').forEach(link => {
                    const href = link.href || '';
                    
                    // 查找父容器
                    let container = link.closest('[class*="card"]') || link.parentElement?.parentElement?.parentElement?.parentElement;
                    if (!container) return;
                    
                    // 提取提示词文本
                    const promptEl = container.querySelector('.font-mono, [class*="whitespace-pre-wrap"]');
                    let promptText = promptEl?.textContent?.trim() || '';
                    
                    // 如果没有找到，尝试从链接文本提取
                    if (!promptText || promptText.length < 20) {
                        const linkText = link.textContent.trim();
                        if (linkText.length > 30 && !linkText.includes('查看完整提示词')) {
                            promptText = linkText;
                        }
                    }
                    
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
                    const allText = Array.from(container.querySelectorAll('*')).map(el => el.textContent?.trim() || '');
                    const dateMatch = allText.find(t => t.match(/\\d{4}年\\d{1,2}月\\d{1,2}日/) || t.match(/\\d+小时前/) || t.match(/昨天|前天/));
                    const date = dateMatch || '';
                    
                    const key = promptText.substring(0, 100);
                    if (seen.has(key)) return;
                    seen.add(key);
                    
                    results.push({
                        url: href,
                        title: title,
                        prompt: promptText,
                        author: author,
                        date: date,
                        image_url: imgUrl
                    });
                });
                
                return results;
            }''')
            
            # 添加新数据
            new_count = 0
            for p in prompts:
                key = p.get('prompt', '')[:100]
                if key and key not in seen_prompts:
                    seen_prompts.add(key)
                    all_prompts.append(p)
                    new_count += 1
            
            print(f"已提取 {len(all_prompts)} 条提示词 (新增 {new_count} 条, 滚动 {scroll_count + 1} 次)")
            
            if len(all_prompts) >= target_count:
                break
            
            # 滚动页面
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
            await page.wait_for_timeout(2000)
            
            # 检查是否加载了新数据
            if new_count == 0:
                no_new_data_count += 1
                if no_new_data_count >= 5:
                    print("连续 5 次没有新数据，停止抓取")
                    break
            else:
                no_new_data_count = 0
            
            scroll_count += 1
        
        await browser.close()
    
    # 保存数据
    with open(output_path, 'w', encoding='utf-8') as f:
        for p in all_prompts:
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
    
    print(f"已保存 {len(all_prompts)} 条数据到 {output_path}")
    return len(all_prompts)

if __name__ == "__main__":
    asyncio.run(scrape_youmind())
