"""
Agent仓库API - 对外暴露的简洁接口
供Agent调用，实现自动读取仓库内容、OCR识别等功能
"""

import json
import sys
from typing import Dict, List, Optional, Any
from vault_reader import VaultReader
from vault_query import VaultQuery


class VaultAPI:
    """仓库API - Agent调用的统一入口"""
    
    def __init__(self, vault_path: str):
        self.reader = VaultReader(vault_path)
        self.query = VaultQuery(self.reader)
        self._initialized = False
    
    def initialize(self, force_rescan: bool = False) -> Dict[str, Any]:
        """初始化仓库，扫描所有文件"""
        notes = self.reader.scan(force=force_rescan)
        self._initialized = True
        
        return {
            'status': 'success',
            'message': f'成功扫描 {len(notes)} 个文件',
            'stats': self.reader.get_stats(),
            'supported_extensions': self.reader.get_supported_extensions(),
            'ocr_status': self.reader.get_ocr_status(),
            'action': 'initialize',
        }
    
    def get_info(self) -> Dict[str, Any]:
        """获取仓库概览信息"""
        if not self._initialized:
            self.initialize()
        
        return {
            'status': 'success',
            'data': {
                'stats': self.reader.get_stats(),
                'folders': list(self.reader.get_folder_structure().keys()),
                'categories': {
                    'inbox': '收件箱', 'project': '项目', 'area': '领域',
                    'resource': '资源库', 'archive': '存档', 'card': '卡片盒',
                    'diary': '日记', 'template': '模板', 'asset': '素材库',
                    'plugin': '插件',
                },
                'supported_extensions': self.reader.get_supported_extensions(),
                'ocr_status': self.reader.get_ocr_status(),
            },
            'action': 'get_info',
        }
    
    def read_note(self, path: str) -> Dict[str, Any]:
        """读取单个文件内容（支持文本和图片）"""
        if not self._initialized:
            self.initialize()
        
        note = self.reader.get_note(path)
        if not note:
            return {'status': 'error', 'message': f'未找到文件: {path}', 'action': 'read_note'}
        
        if note.get('file_type') == 'image' and not note.get('has_ocr'):
            note = self.reader.get_file_content(path).get('data', note)
        
        return {'status': 'success', 'data': note, 'action': 'read_note'}
    
    def read_file(self, path: str) -> Dict[str, Any]:
        """读取文件（自动处理OCR）"""
        if not self._initialized:
            self.initialize()
        return self.reader.get_file_content(path)
    
    def list_notes(self,
                   folder: Optional[str] = None,
                   category: Optional[str] = None,
                   tag: Optional[str] = None,
                   file_type: Optional[str] = None,
                   ext: Optional[str] = None) -> Dict[str, Any]:
        """列出文件列表"""
        if not self._initialized:
            self.initialize()
        
        notes = self.reader.list_notes(
            folder=folder, category=category, tag=tag,
            file_type=file_type, ext=ext
        )
        
        return {
            'status': 'success', 'count': len(notes), 'data': notes, 'action': 'list_notes',
        }
    
    def search(self,
               keyword: Optional[str] = None,
               tags: Optional[List[str]] = None,
               folder: Optional[str] = None,
               category: Optional[str] = None,
               mode: str = 'keyword') -> Dict[str, Any]:
        """搜索文件"""
        if not self._initialized:
            self.initialize()
        
        if mode == 'keyword' and keyword:
            results = self.query.search_by_keyword(keyword)
        elif mode == 'tag' and tags:
            results = self.query.filter_by_tags(tags)
        elif mode == 'ocr' and keyword:
            results = self.query.search_in_ocr(keyword)
        elif mode == 'advanced':
            results = self.query.advanced_search(
                keywords=[keyword] if keyword else None,
                tags=tags, folder=folder, category=category,
            )
        else:
            results = self.reader.list_notes(
                folder=folder, category=category, tag=keyword
            )
        
        simplified = []
        for note in results:
            simplified.append({
                'path': note.get('path'),
                'title': note.get('title'),
                'folder': note.get('folder'),
                'file_type': note.get('file_type'),
                'file_ext': note.get('file_ext'),
                'tags': note.get('tags', [])[:5],
                'word_count': note.get('word_count'),
                'modified_at': note.get('modified_at'),
                'snippet': note.get('snippet', '')[:200],
            })
        
        return {
            'status': 'success', 'count': len(simplified), 'data': simplified, 'action': 'search',
        }
    
    def ocr_image(self, path: str) -> Dict[str, Any]:
        """对指定图片进行OCR识别"""
        if not self._initialized:
            self.initialize()
        return self.reader.ocr_image(path)
    
    def batch_ocr(self, paths: List[str]) -> Dict[str, Any]:
        """批量OCR识别"""
        if not self._initialized:
            self.initialize()
        return self.reader.batch_ocr(paths)
    
    def get_images_needing_ocr(self, limit: int = 20) -> Dict[str, Any]:
        """获取需要OCR的图片列表"""
        if not self._initialized:
            self.initialize()
        images = self.query.get_images_needing_ocr(limit)
        return {'status': 'success', 'count': len(images), 'data': images, 'action': 'get_images_needing_ocr'}
    
    def ocr_all_images(self, limit: int = 50) -> Dict[str, Any]:
        """批量OCR所有未识别的图片"""
        if not self._initialized:
            self.initialize()
        
        images = self.query.get_images_needing_ocr(limit)
        if not images:
            return {'status': 'success', 'message': '没有需要OCR的图片', 'action': 'ocr_all_images'}
        
        paths = [img['path'] for img in images]
        return self.reader.batch_ocr(paths)
    
    def get_tags(self) -> Dict[str, Any]:
        """获取所有标签"""
        if not self._initialized:
            self.initialize()
        tags = self.query.get_all_tags()
        return {'status': 'success', 'data': [{'tag': k, 'count': v} for k, v in tags.items()], 'action': 'get_tags'}
    
    def get_extensions(self) -> Dict[str, Any]:
        """获取所有文件扩展名统计"""
        if not self._initialized:
            self.initialize()
        exts = self.query.get_all_extensions()
        return {'status': 'success', 'data': [{'ext': k, 'count': v} for k, v in exts.items()], 'action': 'get_extensions'}
    
    def get_recent(self, limit: int = 10) -> Dict[str, Any]:
        """获取最近修改的文件"""
        if not self._initialized:
            self.initialize()
        notes = self.query.get_recent_notes(limit)
        return {'status': 'success', 'count': len(notes), 'data': notes, 'action': 'get_recent'}
    
    def get_diaries(self, limit: Optional[int] = None) -> Dict[str, Any]:
        """获取所有日记"""
        if not self._initialized:
            self.initialize()
        diaries = self.query.filter_by_diary(is_diary=True)
        if limit:
            diaries = diaries[:limit]
        return {'status': 'success', 'count': len(diaries), 'data': diaries, 'action': 'get_diaries'}
    
    def get_folder_content(self, folder: str) -> Dict[str, Any]:
        """获取指定文件夹的内容"""
        if not self._initialized:
            self.initialize()
        notes = self.query.filter_by_folder(folder)
        return {'status': 'success', 'folder': folder, 'count': len(notes), 'data': notes, 'action': 'get_folder_content'}
    
    def read_multiple_notes(self, paths: List[str]) -> Dict[str, Any]:
        """批量读取多个文件"""
        if not self._initialized:
            self.initialize()
        
        results = []
        errors = []
        
        for path in paths:
            content = self.reader.get_file_content(path)
            if content['status'] == 'success':
                results.append(content['data'])
            else:
                errors.append(path)
        
        return {
            'status': 'success' if not errors else 'partial_success',
            'successful': len(results), 'failed': len(errors), 'errors': errors,
            'data': results, 'action': 'read_multiple_notes',
        }
    
    def get_diary_by_date(self, date_str: str) -> Dict[str, Any]:
        """按日期获取日记"""
        if not self._initialized:
            self.initialize()
        
        date_patterns = [date_str, date_str.replace('-', '年') + '日']
        
        for note_path, metadata in self.reader._notes.items():
            if metadata.is_diary:
                if any(p in metadata.title for p in date_patterns):
                    return self.read_note(note_path)
        
        diaries = self.query.filter_by_diary(is_diary=True)
        for diary in diaries:
            normalized = date_str.replace('-', '')
            if normalized in diary.get('title', '').replace('年', '').replace('月', '').replace('日', ''):
                return self.read_note(diary['path'])
        
        return {'status': 'error', 'message': f'未找到日期为 {date_str} 的日记', 'action': 'get_diary_by_date'}
    
    def get_supported_extensions(self) -> Dict[str, Any]:
        """获取支持的文件扩展名"""
        return {'status': 'success', 'data': self.reader.get_supported_extensions(), 'action': 'get_supported_extensions'}
    
    def get_ocr_status(self) -> Dict[str, Any]:
        """获取OCR引擎状态"""
        return {'status': 'success', 'data': self.reader.get_ocr_status(), 'action': 'get_ocr_status'}
    
    def execute(self, action: str, params: Optional[Dict] = None) -> Dict[str, Any]:
        """通用执行接口"""
        handlers = {
            'initialize': lambda: self.initialize(params.get('force_rescan', False) if params else False),
            'get_info': lambda: self.get_info(),
            'read_note': lambda: self.read_note(params['path']) if params and 'path' in params else {'status': 'error', 'message': '缺少 path 参数'},
            'read_file': lambda: self.read_file(params['path']) if params and 'path' in params else {'status': 'error', 'message': '缺少 path 参数'},
            'list_notes': lambda: self.list_notes(
                folder=params.get('folder') if params else None,
                category=params.get('category') if params else None,
                tag=params.get('tag') if params else None,
                file_type=params.get('file_type') if params else None,
                ext=params.get('ext') if params else None,
            ),
            'search': lambda: self.search(
                keyword=params.get('keyword') if params else None,
                tags=params.get('tags') if params else None,
                folder=params.get('folder') if params else None,
                category=params.get('category') if params else None,
                mode=params.get('mode', 'keyword') if params else 'keyword',
            ),
            'ocr_image': lambda: self.ocr_image(params['path']) if params and 'path' in params else {'status': 'error', 'message': '缺少 path 参数'},
            'batch_ocr': lambda: self.batch_ocr(params['paths']) if params and 'paths' in params else {'status': 'error', 'message': '缺少 paths 参数'},
            'get_images_needing_ocr': lambda: self.get_images_needing_ocr(params.get('limit', 20) if params else 20),
            'ocr_all_images': lambda: self.ocr_all_images(params.get('limit', 50) if params else 50),
            'get_tags': lambda: self.get_tags(),
            'get_extensions': lambda: self.get_extensions(),
            'get_recent': lambda: self.get_recent(params.get('limit', 10) if params else 10),
            'get_diaries': lambda: self.get_diaries(params.get('limit') if params else None),
            'get_folder_content': lambda: self.get_folder_content(params['folder']) if params and 'folder' in params else {'status': 'error', 'message': '缺少 folder 参数'},
            'read_multiple_notes': lambda: self.read_multiple_notes(params['paths']) if params and 'paths' in params else {'status': 'error', 'message': '缺少 paths 参数'},
            'get_diary_by_date': lambda: self.get_diary_by_date(params['date']) if params and 'date' in params else {'status': 'error', 'message': '缺少 date 参数'},
            'get_supported_extensions': lambda: self.get_supported_extensions(),
            'get_ocr_status': lambda: self.get_ocr_status(),
        }
        
        if action not in handlers:
            return {
                'status': 'error',
                'message': f'未知的动作: {action}',
                'supported_actions': list(handlers.keys()),
                'action': action,
            }
        
        return handlers[action]()


def create_api(vault_path: str) -> VaultAPI:
    """创建API实例的工厂函数"""
    return VaultAPI(vault_path)


def main():
    """命令行入口"""
    import argparse
    
    parser = argparse.ArgumentParser(description='Vault API - 仓库自动化读取工具')
    parser.add_argument('--path', '-p', default='g:\\XXFS\\groWiki', help='仓库路径')
    parser.add_argument('--action', '-a', default='get_info', help='执行的动作')
    parser.add_argument('--params', '-r', default=None, help='动作参数 (JSON格式)')
    parser.add_argument('--output', '-o', default=None, help='输出文件路径')
    
    args = parser.parse_args()
    
    api = create_api(args.path)
    
    params = None
    if args.params:
        try:
            params = json.loads(args.params)
        except json.JSONDecodeError as e:
            print(f"参数解析错误: {e}")
            sys.exit(1)
    
    result = api.execute(args.action, params)
    
    output_text = json.dumps(result, ensure_ascii=False, indent=2)
    
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output_text)
        print(f"结果已保存到: {args.output}")
    else:
        print(output_text)


if __name__ == '__main__':
    main()
