"""
仓库读取器 - 核心模块
支持多种文件类型读取：.md, .txt, .json, .py, .cpp, .jpg, .png
集成PaddleOCR进行图片文字识别
"""

import os
import re
import json
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass, field, asdict
from datetime import datetime


SUPPORTED_TEXT_EXTENSIONS = {
    '.md', '.markdown', '.txt', '.json', '.xml', '.yaml', '.yml',
    '.py', '.cpp', '.c', '.h', '.hpp', '.cs', '.java', '.js', '.ts',
    '.html', '.css', '.vue', '.jsx', '.tsx',
    '.ini', '.cfg', '.conf', '.log', '.csv',
    '.bat', '.ps1', '.sh', '.bash',
}

SUPPORTED_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.gif', '.webp'}

SUPPORTED_EXTENSIONS = SUPPORTED_TEXT_EXTENSIONS | SUPPORTED_IMAGE_EXTENSIONS


@dataclass
class NoteMetadata:
    """文件元数据结构"""
    path: str
    title: str
    folder: str
    folder_depth: int
    file_ext: str = ""
    file_type: str = "text"  # text / image
    language: str = ""
    tags: List[str] = field(default_factory=list)
    links: List[str] = field(default_factory=list)
    word_count: int = 0
    line_count: int = 0
    has_frontmatter: bool = False
    frontmatter: Dict = field(default_factory=dict)
    created_at: Optional[str] = None
    modified_at: Optional[str] = None
    file_size: int = 0
    is_diary: bool = False
    category: str = ""
    ocr_text: str = ""
    has_ocr: bool = False


class VaultReader:
    """Obsidian仓库读取器"""
    
    def __init__(self, vault_path: str):
        self.vault_path = Path(vault_path).resolve()
        self._notes: Dict[str, NoteMetadata] = {}
        self._folder_structure: Dict = {}
        self._ignored_dirs = {
            '.obsidian', '.git', '.agents', '.claude', '.claudian',
            'node_modules', '__pycache__', '.idea', '.vscode',
        }
        self._scan_time: Optional[datetime] = None
        self._ocr_engine = None
        self._ocr_available = False
        self._init_ocr()
    
    def _init_ocr(self):
        """尝试初始化PaddleOCR引擎"""
        try:
            from paddleocr import PaddleOCR
            self._ocr_engine = PaddleOCR(use_angle_cls=True, lang='ch', show_log=False)
            self._ocr_available = True
        except ImportError:
            self._ocr_available = False
            print("[INFO] PaddleOCR未安装，图片识别功能不可用")
            print("[INFO] 安装命令: pip install paddleocr paddlepaddle")
        except Exception as e:
            self._ocr_available = False
            print(f"[WARNING] PaddleOCR初始化失败: {e}")
    
    def scan(self, force: bool = False) -> Dict[str, NoteMetadata]:
        """扫描仓库，返回所有文件的元数据"""
        if self._notes and not force:
            return self._notes
        
        self._notes.clear()
        self._scan_folder_structure()
        
        for root, dirs, files in os.walk(self.vault_path):
            dirs[:] = [d for d in dirs if d not in self._ignored_dirs]
            
            for file in files:
                file_path = Path(root) / file
                if self._should_skip(file_path):
                    continue
                
                metadata = self._extract_metadata(file_path)
                if metadata:
                    self._notes[metadata.path] = metadata
        
        self._scan_time = datetime.now()
        return self._notes
    
    def _should_skip(self, file_path: Path) -> bool:
        ext = file_path.suffix.lower()
        if ext == '.gitkeep':
            return True
        return ext not in SUPPORTED_EXTENSIONS
    
    def _scan_folder_structure(self):
        self._folder_structure = {}
        for item in self.vault_path.iterdir():
            if item.is_dir() and item.name not in self._ignored_dirs:
                self._folder_structure[item.name] = self._build_tree(item, 0)
    
    def _build_tree(self, path: Path, depth: int) -> Dict:
        if depth > 5:
            return {}
        
        tree = {'files': [], 'subdirs': {}}
        try:
            for item in path.iterdir():
                if item.name.startswith('.') or item.name == '__pycache__':
                    continue
                if item.is_dir():
                    tree['subdirs'][item.name] = self._build_tree(item, depth + 1)
                elif item.is_file() and item.suffix.lower() in SUPPORTED_EXTENSIONS:
                    tree['files'].append(item.name)
        except PermissionError:
            pass
        
        return tree
    
    def _extract_metadata(self, file_path: Path) -> Optional[NoteMetadata]:
        try:
            rel_path = file_path.relative_to(self.vault_path)
            ext = file_path.suffix.lower()
            file_type = "image" if ext in SUPPORTED_IMAGE_EXTENSIONS else "text"
            
            mtime = datetime.fromtimestamp(file_path.stat().st_mtime)
            
            metadata = NoteMetadata(
                path=str(rel_path).replace('\\', '/'),
                title=file_path.stem,
                folder=str(rel_path.parent).replace('\\', '/') if rel_path.parent != Path('.') else '',
                folder_depth=len(rel_path.parts) - 1,
                file_ext=ext,
                file_type=file_type,
                file_size=file_path.stat().st_size,
                modified_at=mtime.isoformat(),
                created_at=mtime.isoformat(),
                language=self._detect_language(ext),
            )
            
            if file_type == "image":
                metadata.tags = self._extract_tags_from_filename(metadata.title)
                metadata.links = []
                metadata.word_count = 0
                metadata.line_count = 0
                metadata.is_diary = self._is_diary(metadata)
                metadata.category = self._classify_folder(metadata.folder)
                return metadata
            
            content = self._read_file(file_path)
            if content is None:
                return None
            
            if ext == '.json':
                content = self._format_json(content)
            
            if content.startswith('---'):
                fm, body = self._parse_frontmatter(content)
                if fm:
                    metadata.has_frontmatter = True
                    metadata.frontmatter = fm
                    content = body
            
            metadata.tags = self._extract_tags(content)
            metadata.links = self._extract_links(content)
            metadata.word_count = len(content)
            metadata.line_count = content.count('\n') + 1
            metadata.is_diary = self._is_diary(metadata)
            metadata.category = self._classify_folder(metadata.folder)
            
            return metadata
            
        except Exception as e:
            print(f"[WARNING] 读取文件失败 {file_path}: {e}")
            return None
    
    def _detect_language(self, ext: str) -> str:
        lang_map = {
            '.py': 'python', '.cpp': 'cpp', '.c': 'c', '.h': 'cpp', '.hpp': 'cpp',
            '.cs': 'csharp', '.java': 'java', '.js': 'javascript', '.ts': 'typescript',
            '.jsx': 'javascript', '.tsx': 'typescript',
            '.html': 'html', '.css': 'css', '.vue': 'vue',
            '.json': 'json', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
            '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text',
            '.ini': 'ini', '.cfg': 'config', '.conf': 'config', '.log': 'log',
            '.csv': 'csv', '.bat': 'batch', '.ps1': 'powershell',
            '.sh': 'shell', '.bash': 'shell',
        }
        return lang_map.get(ext, 'unknown')
    
    def _format_json(self, content: str) -> str:
        try:
            data = json.loads(content)
            return json.dumps(data, ensure_ascii=False, indent=2)
        except (json.JSONDecodeError, ValueError):
            return content
    
    def _extract_tags_from_filename(self, filename: str) -> List[str]:
        tags = set()
        tag_pattern = r'#([\w一-鿿\-]+)'
        for match in re.finditer(tag_pattern, filename):
            tag = match.group(1).lower()
            if tag and len(tag) >= 2:
                tags.add(tag)
        return sorted(tags)
    
    def _read_file(self, file_path: Path) -> Optional[str]:
        ext = file_path.suffix.lower()
        
        if ext in SUPPORTED_IMAGE_EXTENSIONS:
            return None
        
        encodings = ['utf-8', 'utf-8-sig', 'gbk', 'gb18030']
        
        for encoding in encodings:
            try:
                return file_path.read_text(encoding=encoding)
            except (UnicodeDecodeError, UnicodeError):
                continue
            except Exception as e:
                print(f"[WARNING] 读取失败 {file_path}: {e}")
                return None
        
        try:
            return file_path.read_text(encoding='utf-8', errors='ignore')
        except Exception:
            return None
    
    def _parse_frontmatter(self, content: str) -> tuple:
        try:
            parts = content.split('---', 2)
            if len(parts) < 3:
                return {}, content
            
            fm_text = parts[1].strip()
            body = parts[2].lstrip('\n')
            
            fm = {}
            current_key = None
            current_value = ""
            in_list = False
            list_items = []
            
            for line in fm_text.split('\n'):
                stripped = line.rstrip()
                
                if not stripped or stripped.startswith('#'):
                    continue
                
                if stripped.startswith('- ') and in_list and current_key:
                    list_items.append(stripped[2:].strip().strip("'\""))
                    continue
                
                if ':' in stripped and not stripped.startswith('-'):
                    if current_key:
                        fm[current_key] = list_items if in_list else current_value
                    current_key, _, value = stripped.partition(':')
                    current_key = current_key.strip()
                    value = value.strip()
                    
                    if not value:
                        in_list = True
                        list_items = []
                        current_value = ""
                    else:
                        in_list = False
                        current_value = value.strip("'\"")
            
            if current_key:
                fm[current_key] = list_items if in_list else current_value
            
            return fm, body
            
        except Exception:
            return {}, content
    
    def _extract_tags(self, content: str) -> List[str]:
        tags = set()
        tag_pattern = r'(?:^|\s)#([\w一-鿿\-]+)(?=\s|$|[^\w一-鿿\-])'
        for match in re.finditer(tag_pattern, content, re.MULTILINE):
            tag = match.group(1).lower()
            if tag and len(tag) >= 2:
                tags.add(tag)
        return sorted(tags)
    
    def _extract_links(self, content: str) -> List[str]:
        links = set()
        link_pattern = r'\[\[([^\]|]+)(?:\|[^\]]+)?\]\]'
        for match in re.finditer(link_pattern, content):
            link = match.group(1).strip()
            if link:
                links.add(link)
        return sorted(links)
    
    def _is_diary(self, metadata: NoteMetadata) -> bool:
        title = metadata.title
        folder = metadata.folder.lower()
        
        if '日记' in folder or '日记' in title:
            return True
        
        date_patterns = [
            r'\d{4}年\d{1,2}月\d{1,2}日',
            r'\d{4}-\d{2}-\d{2}',
            r'\d{4}_\d{2}_\d{2}',
        ]
        for pattern in date_patterns:
            if re.search(pattern, title):
                return True
        
        return False
    
    def _classify_folder(self, folder: str) -> str:
        if not folder:
            return 'inbox'
        
        top_folder = folder.split('/')[0]
        
        classification = {
            '0-收件箱': 'inbox',
            '1-项目': 'project',
            '2-领域': 'area',
            '3-资源库': 'resource',
            '4-存档': 'archive',
            '5-卡片盒': 'card',
            '6-日记': 'diary',
            '7-模板': 'template',
            '8-素材库': 'asset',
            '9-插件': 'plugin',
        }
        
        return classification.get(top_folder, 'other')
    
    def ocr_image(self, file_path: str) -> Dict[str, Any]:
        """对图片进行OCR识别
        
        Args:
            file_path: 图片文件的相对路径或绝对路径
            
        Returns:
            OCR识别结果
        """
        if not self._ocr_available:
            return {
                'status': 'error',
                'message': 'PaddleOCR未安装，请运行: pip install paddleocr paddlepaddle',
            }
        
        abs_path = self.vault_path / file_path if not os.path.isabs(file_path) else Path(file_path)
        
        if not abs_path.exists():
            return {'status': 'error', 'message': f'文件不存在: {abs_path}'}
        
        ext = abs_path.suffix.lower()
        if ext not in SUPPORTED_IMAGE_EXTENSIONS:
            return {'status': 'error', 'message': f'不支持的图片格式: {ext}'}
        
        try:
            result = self._ocr_engine.ocr(str(abs_path), cls=True)
            
            if not result or not result[0]:
                return {'status': 'success', 'text': '', 'details': [], 'message': '未识别到文字'}
            
            texts = []
            details = []
            
            for line in result[0]:
                bbox, (text, confidence) = line
                texts.append(text)
                details.append({
                    'text': text,
                    'confidence': round(confidence, 4),
                    'bbox': [[round(p[0], 2), round(p[1], 2)] for p in bbox],
                })
            
            full_text = '\n'.join(texts)
            
            if file_path in self._notes:
                self._notes[file_path].ocr_text = full_text
                self._notes[file_path].has_ocr = True
            
            return {
                'status': 'success',
                'file_path': file_path,
                'text': full_text,
                'text_count': len(texts),
                'confidence_avg': round(sum(d['confidence'] for d in details) / len(details), 4) if details else 0,
                'details': details,
                'message': 'OCR识别成功',
            }
            
        except Exception as e:
            return {'status': 'error', 'message': f'OCR识别失败: {str(e)}'}
    
    def batch_ocr(self, image_paths: List[str]) -> Dict[str, Any]:
        """批量OCR识别
        
        Args:
            image_paths: 图片路径列表
            
        Returns:
            批量识别结果
        """
        results = []
        errors = []
        
        for path in image_paths:
            result = self.ocr_image(path)
            if result['status'] == 'success':
                results.append(result)
            else:
                errors.append({'path': path, 'error': result.get('message', '未知错误')})
        
        return {
            'status': 'success',
            'total': len(image_paths),
            'successful': len(results),
            'failed': len(errors),
            'results': results,
            'errors': errors,
        }
    
    def get_note(self, path: str) -> Optional[Dict]:
        """获取单个文件的完整内容"""
        if not self._notes:
            self.scan()
        
        metadata = self._notes.get(path)
        if not metadata:
            return None
        
        file_path = self.vault_path / path
        result = asdict(metadata)
        
        if metadata.file_type == "image":
            result['content'] = ''
            if metadata.has_ocr:
                result['content'] = metadata.ocr_text
        else:
            result['content'] = self._read_file(file_path) or ''
        
        return result
    
    def get_file_content(self, path: str) -> Dict[str, Any]:
        """获取文件内容（支持OCR图片）"""
        note = self.get_note(path)
        if not note:
            return {'status': 'error', 'message': f'文件不存在: {path}'}
        
        if note.get('file_type') == 'image' and not note.get('has_ocr'):
            ocr_result = self.ocr_image(path)
            if ocr_result['status'] == 'success':
                note['content'] = ocr_result['text']
                note['ocr_result'] = ocr_result
            else:
                note['ocr_error'] = ocr_result.get('message', '')
        
        return {'status': 'success', 'data': note}
    
    def get_folder_structure(self) -> Dict:
        if not self._folder_structure:
            self._scan_folder_structure()
        return self._folder_structure
    
    def get_stats(self) -> Dict:
        if not self._notes:
            self.scan()
        
        total_files = len(self._notes)
        total_text = sum(1 for n in self._notes.values() if n.file_type == "text")
        total_images = sum(1 for n in self._notes.values() if n.file_type == "image")
        total_words = sum(n.word_count for n in self._notes.values())
        total_size = sum(n.file_size for n in self._notes.values())
        
        by_category: Dict[str, int] = {}
        for note in self._notes.values():
            cat = note.category or 'unknown'
            by_category[cat] = by_category.get(cat, 0) + 1
        
        by_ext: Dict[str, int] = {}
        for note in self._notes.values():
            ext = note.file_ext or 'unknown'
            by_ext[ext] = by_ext.get(ext, 0) + 1
        
        by_folder: Dict[str, int] = {}
        for note in self._notes.values():
            folder = note.folder or '根目录'
            top_folder = folder.split('/')[0]
            by_folder[top_folder] = by_folder.get(top_folder, 0) + 1
        
        all_tags: Dict[str, int] = {}
        for note in self._notes.values():
            for tag in note.tags:
                all_tags[tag] = all_tags.get(tag, 0) + 1
        
        return {
            'total_files': total_files,
            'text_files': total_text,
            'image_files': total_images,
            'total_words': total_words,
            'total_size_mb': round(total_size / 1024 / 1024, 2),
            'by_category': by_category,
            'by_extension': by_ext,
            'by_folder': by_folder,
            'total_tags': len(all_tags),
            'top_tags': sorted(all_tags.items(), key=lambda x: x[1], reverse=True)[:20],
            'ocr_available': self._ocr_available,
            'scan_time': self._scan_time.isoformat() if self._scan_time else None,
        }
    
    def list_notes(self,
                   folder: Optional[str] = None,
                   category: Optional[str] = None,
                   tag: Optional[str] = None,
                   is_diary: Optional[bool] = None,
                   file_type: Optional[str] = None,
                   ext: Optional[str] = None) -> List[Dict]:
        """列出文件，支持多种过滤条件"""
        if not self._notes:
            self.scan()
        
        results = []
        
        for path, metadata in self._notes.items():
            if folder and not metadata.folder.startswith(folder):
                continue
            if category and metadata.category != category:
                continue
            if tag and tag.lower() not in [t.lower() for t in metadata.tags]:
                continue
            if is_diary is not None and metadata.is_diary != is_diary:
                continue
            if file_type and metadata.file_type != file_type:
                continue
            if ext and metadata.file_ext != ext:
                continue
            
            results.append(asdict(metadata))
        
        return sorted(results, key=lambda x: x['path'])
    
    def get_supported_extensions(self) -> Dict[str, List[str]]:
        """获取支持的文件扩展名"""
        return {
            'text': sorted(SUPPORTED_TEXT_EXTENSIONS),
            'image': sorted(SUPPORTED_IMAGE_EXTENSIONS),
            'all': sorted(SUPPORTED_EXTENSIONS),
        }
    
    def get_ocr_status(self) -> Dict[str, Any]:
        """获取OCR引擎状态"""
        return {
            'available': self._ocr_available,
            'engine': 'PaddleOCR' if self._ocr_available else 'Not installed',
            'supported_extensions': sorted(SUPPORTED_IMAGE_EXTENSIONS),
            'install_command': 'pip install paddleocr paddlepaddle',
        }
