"""
仓库查询器 - 提供搜索、过滤、统计、OCR等查询能力
"""

import re
from typing import Dict, List, Optional
from vault_reader import VaultReader, NoteMetadata


class VaultQuery:
    """仓库查询器 - 支持多种查询方式"""
    
    def __init__(self, reader: VaultReader):
        self.reader = reader
    
    def search_by_keyword(self,
                          keyword: str,
                          search_in: str = 'all',
                          case_sensitive: bool = False) -> List[Dict]:
        """按关键词搜索
        
        Args:
            keyword: 搜索关键词
            search_in: 搜索范围 (title/content/tag/all/ocr)
            case_sensitive: 是否区分大小写
        """
        if not self.reader._notes:
            self.reader.scan()
        
        results = []
        keyword_lower = keyword.lower()
        
        for path, metadata in self.reader._notes.items():
            matched = False
            
            if search_in in ('title', 'all'):
                title = metadata.title
                if not case_sensitive:
                    title = title.lower()
                if keyword_lower in title:
                    matched = True
            
            if not matched and search_in in ('tag', 'all'):
                tags_text = ' '.join(metadata.tags).lower()
                if keyword_lower in tags_text:
                    matched = True
            
            if not matched and search_in in ('content', 'title_content', 'all', 'ocr'):
                content_data = self.reader.get_note(path)
                if content_data:
                    note_content = content_data.get('content', '')
                    if not case_sensitive:
                        note_content = note_content.lower()
                    if keyword_lower in note_content:
                        matched = True
                        content_data['snippet'] = self._get_snippet(
                            content_data.get('content', ''),
                            keyword, case_sensitive
                        )
                    elif search_in == 'ocr' and metadata.ocr_text:
                        ocr_text = metadata.ocr_text.lower()
                        if keyword_lower in ocr_text:
                            matched = True
                            content_data['snippet'] = self._get_snippet(
                                metadata.ocr_text, keyword, case_sensitive
                            )
            
            if matched:
                note_data = self.reader.get_note(path)
                if note_data:
                    if search_in in ('content', 'title_content', 'all') and 'snippet' not in note_data:
                        note_data['snippet'] = self._get_snippet(
                            note_data.get('content', ''), keyword, case_sensitive
                        )
                    results.append(note_data)
        
        return results
    
    def search_in_ocr(self, keyword: str) -> List[Dict]:
        """在OCR识别结果中搜索"""
        if not self.reader._notes:
            self.reader.scan()
        
        results = []
        keyword_lower = keyword.lower()
        
        for path, metadata in self.reader._notes.items():
            if metadata.has_ocr and metadata.ocr_text:
                if keyword_lower in metadata.ocr_text.lower():
                    note_data = self.reader.get_note(path)
                    if note_data:
                        note_data['snippet'] = self._get_snippet(metadata.ocr_text, keyword)
                        results.append(note_data)
            elif metadata.file_type == "image" and not metadata.has_ocr:
                ocr_result = self.reader.ocr_image(path)
                if ocr_result['status'] == 'success' and keyword_lower in ocr_result['text'].lower():
                    note_data = self.reader.get_note(path)
                    if note_data:
                        note_data['snippet'] = self._get_snippet(ocr_result['text'], keyword)
                        note_data['ocr_text'] = ocr_result['text']
                        results.append(note_data)
        
        return results
    
    def search_by_regex(self,
                        pattern: str,
                        search_in: str = 'content') -> List[Dict]:
        """按正则表达式搜索"""
        if not self.reader._notes:
            self.reader.scan()
        
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error:
            return []
        
        results = []
        
        for path, metadata in self.reader._notes.items():
            matched = False
            
            if search_in in ('title', 'all'):
                if regex.search(metadata.title):
                    matched = True
            
            if not matched and search_in in ('content', 'all'):
                note = self.reader.get_note(path)
                if note and regex.search(note.get('content', '')):
                    matched = True
            
            if matched:
                results.append(self.reader.get_note(path))
        
        return results
    
    def filter_by_tags(self,
                       tags: List[str],
                       match_mode: str = 'AND') -> List[Dict]:
        """按标签过滤"""
        if not self.reader._notes:
            self.reader.scan()
        
        results = []
        target_tags = {t.lower() for t in tags}
        
        for path, metadata in self.reader._notes.items():
            note_tags = {t.lower() for t in metadata.tags}
            
            if match_mode == 'AND':
                if target_tags.issubset(note_tags):
                    results.append(self.reader.get_note(path))
            else:
                if target_tags & note_tags:
                    results.append(self.reader.get_note(path))
        
        return sorted(results, key=lambda x: x['path'])
    
    def filter_by_folder(self,
                         folder: str,
                         recursive: bool = True) -> List[Dict]:
        """按文件夹过滤"""
        if not self.reader._notes:
            self.reader.scan()
        
        results = []
        
        for path, metadata in self.reader._notes.items():
            if recursive:
                if metadata.folder.startswith(folder):
                    results.append(self.reader.get_note(path))
            else:
                if metadata.folder == folder:
                    results.append(self.reader.get_note(path))
        
        return sorted(results, key=lambda x: x['path'])
    
    def filter_by_category(self, category: str) -> List[Dict]:
        """按PARA分类过滤"""
        return self.reader.list_notes(category=category)
    
    def filter_by_file_type(self, file_type: str) -> List[Dict]:
        """按文件类型过滤 (text/image)"""
        return self.reader.list_notes(file_type=file_type)
    
    def filter_by_extension(self, ext: str) -> List[Dict]:
        """按文件扩展名过滤"""
        return self.reader.list_notes(ext=ext)
    
    def filter_by_diary(self, is_diary: bool = True) -> List[Dict]:
        """过滤日记"""
        return self.reader.list_notes(is_diary=is_diary)
    
    def get_all_tags(self) -> Dict[str, int]:
        """获取所有标签及其使用频率"""
        if not self.reader._notes:
            self.reader.scan()
        
        tags = {}
        for metadata in self.reader._notes.values():
            for tag in metadata.tags:
                tags[tag] = tags.get(tag, 0) + 1
        
        return dict(sorted(tags.items(), key=lambda x: x[1], reverse=True))
    
    def get_all_extensions(self) -> Dict[str, int]:
        """获取所有文件扩展名统计"""
        if not self.reader._notes:
            self.reader.scan()
        
        exts = {}
        for metadata in self.reader._notes.values():
            ext = metadata.file_ext or 'unknown'
            exts[ext] = exts.get(ext, 0) + 1
        
        return dict(sorted(exts.items(), key=lambda x: x[1], reverse=True))
    
    def get_images_needing_ocr(self, limit: int = 20) -> List[Dict]:
        """获取未进行OCR的图片文件"""
        if not self.reader._notes:
            self.reader.scan()
        
        results = []
        for path, metadata in self.reader._notes.items():
            if metadata.file_type == "image" and not metadata.has_ocr:
                results.append({
                    'path': path,
                    'title': metadata.title,
                    'file_ext': metadata.file_ext,
                    'file_size': metadata.file_size,
                    'folder': metadata.folder,
                })
                if len(results) >= limit:
                    break
        
        return results
    
    def get_related_notes(self, path: str) -> List[Dict]:
        """获取关联笔记（通过链接关系）"""
        if not self.reader._notes:
            self.reader.scan()
        
        note = self.reader._notes.get(path)
        if not note:
            return []
        
        related_paths = set()
        
        for link in note.links:
            for note_path, metadata in self.reader._notes.items():
                if link in note_path or link == metadata.title:
                    related_paths.add(note_path)
        
        for note_path, metadata in self.reader._notes.items():
            if path != note_path:
                for link in metadata.links:
                    if link in path or link == note.title:
                        related_paths.add(note_path)
        
        return [self.reader.get_note(p) for p in related_paths if p in self.reader._notes]
    
    def get_recent_notes(self, limit: int = 10) -> List[Dict]:
        """获取最近修改的文件"""
        if not self.reader._notes:
            self.reader.scan()
        
        sorted_notes = sorted(
            self.reader._notes.values(),
            key=lambda x: x.modified_at or '',
            reverse=True
        )
        
        return [self.reader.get_note(n.path) for n in sorted_notes[:limit]]
    
    def _get_snippet(self, content: str, keyword: str,
                     case_sensitive: bool = False, context_chars: int = 50) -> str:
        """获取关键词周围的上下文片段"""
        if not content:
            return ''
        
        search_content = content if case_sensitive else content.lower()
        search_keyword = keyword if case_sensitive else keyword.lower()
        
        pos = search_content.find(search_keyword)
        if pos == -1:
            return content[:context_chars] + '...' if len(content) > context_chars else content
        
        start = max(0, pos - context_chars)
        end = min(len(content), pos + len(keyword) + context_chars)
        
        snippet = content[start:end]
        if start > 0:
            snippet = '...' + snippet
        if end < len(content):
            snippet += '...'
        
        return snippet
    
    def advanced_search(self,
                        keywords: Optional[List[str]] = None,
                        tags: Optional[List[str]] = None,
                        folder: Optional[str] = None,
                        category: Optional[str] = None,
                        file_type: Optional[str] = None,
                        ext: Optional[str] = None,
                        search_ocr: bool = False,
                        min_word_count: Optional[int] = None,
                        max_word_count: Optional[int] = None) -> List[Dict]:
        """高级搜索 - 多条件组合查询"""
        if not self.reader._notes:
            self.reader.scan()
        
        results = []
        
        for path, metadata in self.reader._notes.items():
            if folder and not metadata.folder.startswith(folder):
                continue
            if category and metadata.category != category:
                continue
            if file_type and metadata.file_type != file_type:
                continue
            if ext and metadata.file_ext != ext:
                continue
            
            if tags:
                note_tags_lower = {t.lower() for t in metadata.tags}
                if not all(t.lower() in note_tags_lower for t in tags):
                    continue
            
            if min_word_count and metadata.word_count < min_word_count:
                continue
            if max_word_count and metadata.word_count > max_word_count:
                continue
            
            if keywords:
                note = self.reader.get_note(path)
                if note:
                    search_text = (note.get('title', '') + ' ' + 
                                  note.get('content', '')).lower()
                    if search_ocr and metadata.ocr_text:
                        search_text += ' ' + metadata.ocr_text.lower()
                    if not all(k.lower() in search_text for k in keywords):
                        continue
            
            results.append(self.reader.get_note(path))
        
        return sorted(results, key=lambda x: x['path'])
