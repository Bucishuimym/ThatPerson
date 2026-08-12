"""
Vault Reader Package - Obsidian仓库自动化读取工具
供Agent调用，实现自动读取和查询仓库内容
支持多文件类型：.md, .txt, .json, .py, .cpp, .jpg, .png
集成PaddleOCR图片文字识别
"""

from vault_reader import VaultReader, NoteMetadata, SUPPORTED_EXTENSIONS, SUPPORTED_TEXT_EXTENSIONS, SUPPORTED_IMAGE_EXTENSIONS
from vault_query import VaultQuery
from vault_api import VaultAPI, create_api
from vault_env import setup_api, setup_check, pick_default_vault, find_vaults, find_obsidian_executable

__all__ = [
    'VaultReader', 'VaultQuery', 'VaultAPI', 'create_api', 'NoteMetadata',
    'SUPPORTED_EXTENSIONS', 'SUPPORTED_TEXT_EXTENSIONS', 'SUPPORTED_IMAGE_EXTENSIONS',
    'setup_api', 'setup_check', 'pick_default_vault', 'find_vaults', 'find_obsidian_executable',
]
__version__ = '2.1.0'
