"""
示例脚本 - 演示如何使用Vault API
支持多文件类型读取和PaddleOCR图片识别
"""

import json
from vault_api import create_api, VaultAPI


def _default_vault():
    """自动探测本机 Obsidian 默认仓库，不再硬编码单机路径。"""
    from vault_env import pick_default_vault
    vault = pick_default_vault()
    if not vault:
        raise SystemExit(
            "未找到 Obsidian 仓库。请先打开 Obsidian 创建/注册仓库，"
            "或修改本脚本直接传入 create_api(\"<仓库路径>\")。"
        )
    print(f"[info] 使用仓库: {vault['path']}")
    return vault['path']


def demo_basic_usage():
    """基础用法演示"""
    print("=" * 60)
    print("📚 Vault API 2.0 基础用法演示")
    print("=" * 60)
    
    vault_path = _default_vault()
    api = create_api(vault_path)
    
    print("\n🔍 步骤1: 初始化仓库")
    result = api.initialize()
    print(f"   {result['message']}")
    print(f"   支持的文本文件: {len(result['supported_extensions']['text'])} 种")
    print(f"   支持的图片文件: {len(result['supported_extensions']['image'])} 种")
    print(f"   OCR状态: {'已就绪' if result['ocr_status']['available'] else '未安装'}")
    
    print("\n📊 步骤2: 获取仓库概览")
    info = api.get_info()
    stats = info['data']['stats']
    print(f"   - 文件总数: {stats['total_files']}")
    print(f"   - 文本文件: {stats['text_files']}")
    print(f"   - 图片文件: {stats['image_files']}")
    print(f"   - 总字数: {stats['total_words']}")
    print(f"   - 仓库大小: {stats['total_size_mb']} MB")
    
    print("\n   按扩展名统计:")
    ext_data = api.get_extensions()
    for item in ext_data['data'][:8]:
        print(f"     {item['ext']}: {item['count']} 个")
    
    print("\n📁 步骤3: 列出不同类型的文件")
    markdown_files = api.list_notes(ext='.md')
    print(f"   Markdown文件: {markdown_files['count']} 个")
    
    python_files = api.list_notes(ext='.py')
    print(f"   Python文件: {python_files['count']} 个")
    
    image_files = api.list_notes(file_type='image')
    print(f"   图片文件: {image_files['count']} 个")
    
    if image_files['data']:
        print(f"   图片示例: {image_files['data'][0]['title']} ({image_files['data'][0]['file_ext']})")
    
    print("\n📖 步骤4: 读取各种文件类型")
    if markdown_files['data']:
        md_path = markdown_files['data'][0]['path']
        result = api.read_note(md_path)
        if result['status'] == 'success':
            print(f"   Markdown [{md_path}]: {result['data']['word_count']} 字")
    
    if python_files['data']:
        py_path = python_files['data'][0]['path']
        result = api.read_note(py_path)
        if result['status'] == 'success':
            content_preview = result['data']['content'][:100]
            print(f"   Python [{py_path}]: 语言={result['data']['language']}")
            print(f"     预览: {content_preview}...")
    
    print("\n🔎 步骤5: 搜索功能")
    search_results = api.search(keyword='Agent')
    print(f"   搜索 'Agent': 找到 {search_results['count']} 个匹配")
    for item in search_results['data'][:3]:
        print(f"   - [{item['path']}] {item['title']} ({item['file_type']})")
    
    print("\n" + "=" * 60)
    print("✅ 基础演示完成")
    print("=" * 60)


def demo_ocr_usage():
    """OCR图片识别演示"""
    print("\n" + "=" * 60)
    print("🖼️ OCR图片识别演示")
    print("=" * 60)
    
    vault_path = _default_vault()
    api = create_api(vault_path)
    api.initialize()
    
    ocr_status = api.get_ocr_status()
    print(f"\nOCR引擎: {ocr_status['data']['engine']}")
    
    if not ocr_status['data']['available']:
        print("  PaddleOCR未安装")
        print("  安装命令: pip install paddleocr paddlepaddle")
        print("  访问: https://paddleocr.bj.bcebos.com/ 了解更多")
        return
    
    print("\n📸 获取需要OCR的图片列表")
    images = api.get_images_needing_ocr(limit=5)
    print(f"  需要OCR的图片: {images['count']} 张")
    
    if images['data']:
        print("\n🔍 对第一张图片进行OCR识别")
        first_image = images['data'][0]
        print(f"  图片: {first_image['path']}")
        
        result = api.ocr_image(first_image['path'])
        if result['status'] == 'success':
            print(f"  识别文字数: {result['text_count']}")
            print(f"  平均置信度: {result['confidence_avg']}")
            print(f"  识别文本预览: {result['text'][:200]}...")
        else:
            print(f"  识别失败: {result.get('message')}")
    
    print("\n📦 批量OCR识别")
    if images['count'] > 1:
        paths = [img['path'] for img in images['data'][:3]]
        batch_result = api.batch_ocr(paths)
        print(f"  批量结果: 成功 {batch_result['successful']}/{batch_result['total']}")
        
        for r in batch_result['results'][:2]:
            print(f"    - {r['file_path']}: {r['text_count']} 个文字, 置信度 {r['confidence_avg']}")
    
    print("\n🔎 在OCR结果中搜索")
    search_results = api.search(keyword='2026', mode='ocr')
    print(f"  在OCR结果中搜索 '2026': 找到 {search_results['count']} 个匹配")
    
    print("\n" + "=" * 60)
    print("✅ OCR演示完成")
    print("=" * 60)


def demo_agent_usage():
    """Agent使用示例"""
    print("\n" + "=" * 60)
    print("🤖 Agent使用示例")
    print("=" * 60)
    
    vault_path = _default_vault()
    api = create_api(vault_path)
    api.initialize()
    
    print("\n场景1: Agent获取仓库结构")
    info = api.execute('get_info')
    print(f"  {info['data']['stats']['total_files']} 个文件")
    
    print("\n场景2: Agent搜索特定内容")
    results = api.execute('search', {'keyword': '大语言模型'})
    print(f"  找到 {results['count']} 个相关文件")
    for item in results['data'][:3]:
        print(f"  - {item['title']} ({item['file_ext']})")
    
    print("\n场景3: Agent获取所有图片")
    images = api.execute('list_notes', {'file_type': 'image'})
    print(f"  共 {images['count']} 张图片")
    
    print("\n场景4: Agent读取代码文件")
    code_files = api.execute('list_notes', {'ext': '.py'})
    if code_files['data']:
        code = api.execute('read_file', {'path': code_files['data'][0]['path']})
        print(f"  读取: {code_files['data'][0]['path']}")
        if code['status'] == 'success':
            print(f"  语言: {code['data'].get('language', 'unknown')}")
            print(f"  大小: {len(code['data'].get('content', ''))} 字符")
    
    print("\n场景5: Agent查看OCR状态")
    ocr_status = api.execute('get_ocr_status')
    print(f"  OCR可用: {ocr_status['data']['available']}")
    print(f"  支持格式: {ocr_status['data']['supported_extensions']}")
    
    print("\n场景6: Agent获取标签云")
    tags = api.execute('get_tags')
    print(f"  共 {len(tags['data'])} 个标签")
    for tag in tags['data'][:5]:
        print(f"    #{tag['tag']}: {tag['count']} 次")
    
    print("\n" + "=" * 60)
    print("✅ Agent示例完成")
    print("=" * 60)


if __name__ == '__main__':
    demo_basic_usage()
    demo_ocr_usage()
    demo_agent_usage()
