"""
Obsidian 环境探测与初始化 - 让 vault-api-bridge 不再绑定单一电脑、单一仓库

本模块解决两类问题：
1. 「只适用于我这台电脑」：不再硬编码仓库绝对路径，自动检测本机是否安装
   Obsidian、有哪些已注册仓库（vault），并挑选一个默认仓库。
2. 「没有 Obsidian 怎么办」：未安装时，可下载官方 Windows 安装包
   （下载动作必须先征得用户同意，本模块只负责执行）。

只读原则：本模块只读系统配置（%APPDATA%/obsidian/obsidian.json）与仓库路径，
绝不写仓库内容；唯一写盘动作是 --download 把安装包下载到 Downloads 目录。

用法：
  python vault_env.py              # 打印环境自检报告（JSON）
  python vault_env.py --pick-vault # 只输出默认仓库绝对路径（供脚本引用）
  python vault_env.py --download   # 下载 Obsidian 安装包（需已获用户同意）
  python vault_env.py --download --dest D:\\tools  # 指定下载目录
"""

import json
import os
import pathlib
import re
import shutil
import sys
import urllib.request
from typing import Dict, List, Optional

# ---------------------------------------------------------------------------
# 1. 检测 Obsidian 是否安装
# ---------------------------------------------------------------------------

OBSIDIAN_EXE_CANDIDATES = [
    'Obsidian', 'obsidian', 'Obsidian.exe', 'obsidian.exe',
]

def _exe_installed(name: str) -> Optional[pathlib.Path]:
    """在 PATH 中查找可执行文件（macOS/Linux 的 CLI 入口）"""
    found = shutil.which(name)
    return pathlib.Path(found) if found else None


def _appdata_dir() -> Optional[pathlib.Path]:
    """返回 Obsidian 配置目录（跨平台）"""
    if os.name == 'nt':
        base = os.environ.get('APPDATA')
        return pathlib.Path(base) / 'obsidian' if base else None
    # macOS / Linux
    home = pathlib.Path.home()
    if sys.platform == 'darwin':
        return home / 'Library' / 'Application Support' / 'obsidian'
    return pathlib.Path(os.environ.get('XDG_CONFIG_HOME', str(home / '.config'))) / 'obsidian'


def _registry_obsidian_exe() -> Optional[pathlib.Path]:
    """从 Windows 卸载注册表项推导 Obsidian 安装位置（兜底，处理自定义安装盘/路径）。

    用户可能把 Obsidian 装到任意目录（如 G:\\XXFS\\Obsidian），此时
    PATH 与标准安装位置都找不到，注册表 Uninstall 项是最可靠的来源。
    """
    if os.name != 'nt':
        return None
    try:
        import winreg
    except ImportError:
        return None

    uninstall_keys = [
        (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'),
    ]

    for hkey, key_path in uninstall_keys:
        try:
            with winreg.OpenKey(hkey, key_path) as base:
                for i in range(winreg.QueryInfoKey(base)[0]):
                    try:
                        with winreg.OpenKey(base, winreg.EnumKey(base, i)) as sub:
                            try:
                                display, _ = winreg.QueryValueEx(sub, 'DisplayName')
                            except OSError:
                                continue
                            if not display or 'obsidian' not in display.lower():
                                continue
                            # 优先 InstallLocation
                            try:
                                loc, _ = winreg.QueryValueEx(sub, 'InstallLocation')
                                if loc:
                                    exe = pathlib.Path(loc) / 'Obsidian.exe'
                                    if exe.exists():
                                        return exe
                            except OSError:
                                pass
                            # 其次从 UninstallString 所在目录推导
                            try:
                                uninst, _ = winreg.QueryValueEx(sub, 'UninstallString')
                                if uninst:
                                    raw = uninst
                                    if raw.startswith('"'):
                                        raw = raw.split('"')[1]
                                    exe = pathlib.Path(raw).parent / 'Obsidian.exe'
                                    if exe.exists():
                                        return exe
                            except OSError:
                                pass
                    except OSError:
                        continue
        except OSError:
            continue
    return None


def find_obsidian_executable() -> Optional[pathlib.Path]:
    """检测本机是否安装 Obsidian，返回可执行文件路径；未安装返回 None。

    依次检查：
      1. PATH（Obsidian CLI，macOS/Linux 常见）
      2. Windows 常见安装位置（%LOCALAPPDATA%、Program Files）
      3. Windows 注册表卸载项（覆盖自定义安装路径）
    """
    for name in OBSIDIAN_EXE_CANDIDATES:
        exe = _exe_installed(name)
        if exe:
            return exe

    if os.name == 'nt':
        local = os.environ.get('LOCALAPPDATA')
        program_files = os.environ.get('ProgramFiles')
        program_files_x86 = os.environ.get('ProgramFiles(x86)')
        roots = []
        if local:
            roots.append(pathlib.Path(local) / 'Obsidian')
            roots.append(pathlib.Path(local) / 'Programs' / 'Obsidian')
        if program_files:
            roots.append(pathlib.Path(program_files) / 'Obsidian')
        if program_files_x86:
            roots.append(pathlib.Path(program_files_x86) / 'Obsidian')

        for root in roots:
            exe = root / 'Obsidian.exe'
            if exe.exists():
                return exe

    return _registry_obsidian_exe()


# ---------------------------------------------------------------------------
# 2. 读取已注册仓库（vault）列表
# ---------------------------------------------------------------------------

def find_vaults() -> List[Dict]:
    """读取 obsidian.json，返回所有存在的已注册仓库。

    返回按最近添加（ts）倒序排列的列表，每项：
      {'id': str, 'path': str, 'ts': int, 'open': bool}
    路径不存在的仓库会被剔除。
    """
    config_dir = _appdata_dir()
    if not config_dir:
        return []
    config_file = config_dir / 'obsidian.json'
    if not config_file.exists():
        return []

    try:
        data = json.loads(config_file.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return []

    vaults = []
    for vid, info in (data.get('vaults') or {}).items():
        path_str = (info or {}).get('path', '')
        if not path_str:
            continue
        p = pathlib.Path(path_str)
        if not p.is_dir():
            continue
        vaults.append({
            'id': vid,
            'path': str(p),
            'ts': int((info or {}).get('ts', 0) or 0),
            'open': bool((info or {}).get('open', False)),
        })

    vaults.sort(key=lambda v: v['ts'], reverse=True)
    return vaults


# ---------------------------------------------------------------------------
# 3. 挑选默认仓库
# ---------------------------------------------------------------------------

PARA_TOP_FOLDERS = [
    '0-收件箱', '1-项目', '2-领域', '3-资源库', '4-存档',
    '5-卡片盒', '6-日记', '7-模板', '8-素材库', '9-插件',
]

def _looks_like_para(vault_path: pathlib.Path) -> bool:
    """判断仓库是否为 PARA 风格（顶层存在"数字-"目录或命中 PARA 中文名）"""
    try:
        names = [d.name for d in vault_path.iterdir() if d.is_dir()]
    except OSError:
        return False
    for name in names:
        if name in PARA_TOP_FOLDERS:
            return True
        if re.match(r'^\d+\s*[-_]\s*\S', name):
            return True
    return False


def pick_default_vault(vaults: Optional[List[Dict]] = None) -> Optional[Dict]:
    """挑选默认仓库，优先级：
        1. PARA 风格仓库（vault-api-bridge 原生适配结构）
        2. 当前打开（open: true）的仓库
        3. 最近添加（ts 最大）的仓库
        4. 任意唯一仓库
    无仓库时返回 None。
    """
    if vaults is None:
        vaults = find_vaults()
    if not vaults:
        return None

    para = [v for v in vaults if _looks_like_para(pathlib.Path(v['path']))]
    if para:
        return para[0]

    opened = [v for v in vaults if v.get('open')]
    if opened:
        return opened[0]

    return vaults[0]


# ---------------------------------------------------------------------------
# 4. 一键：定位脚本目录 + 返回 VaultAPI 实例
# ---------------------------------------------------------------------------

def locate_script_dir() -> pathlib.Path:
    """返回 vault-api-bridge 的脚本目录（本模块所在目录）。"""
    return pathlib.Path(__file__).resolve().parent


def setup_api(vault_path: Optional[str] = None):
    """一键创建 VaultAPI 实例。

    1. 确保脚本目录在 sys.path（本模块与 vault_api.py 同目录）
    2. 未指定仓库时，自动探测默认仓库
    3. 返回已 create_api 的实例（尚未 initialize）

    Args:
        vault_path: 显式指定仓库路径；缺省自动探测。

    Raises:
        RuntimeError: 未检测到任何 Obsidian 仓库。
    """
    script_dir = locate_script_dir()
    if str(script_dir) not in sys.path:
        sys.path.insert(0, str(script_dir))

    if not vault_path:
        vault = pick_default_vault()
        if not vault:
            raise RuntimeError(
                '未检测到 Obsidian 仓库。请先打开 Obsidian 创建/注册一个仓库，'
                '或用 setup_api("<仓库绝对路径>") / --path 显式指定。'
            )
        vault_path = vault['path']

    from vault_api import create_api  # 延迟导入，避免与 vault_api 循环依赖
    return create_api(vault_path)


# ---------------------------------------------------------------------------
# 5. 环境自检报告
# ---------------------------------------------------------------------------

def setup_check() -> Dict:
    """返回环境自检报告（供 Agent 判断下一步动作）。"""
    exe = find_obsidian_executable()
    vaults = find_vaults()
    default = pick_default_vault(vaults)
    return {
        'obsidian_installed': exe is not None,
        'obsidian_path': str(exe) if exe else None,
        'obsidian_config': str(_appdata_dir()) if _appdata_dir() else None,
        'vault_count': len(vaults),
        'vaults': vaults,
        'default_vault': default['path'] if default else None,
    }


# ---------------------------------------------------------------------------
# 6. 下载 Obsidian 安装包（需调用方先征得用户同意）
# ---------------------------------------------------------------------------

OBSIDIAN_RELEASE_API = 'https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest'


def _latest_windows_installer_url() -> tuple:
    """从 GitHub Releases 查询最新 Windows 安装包的 (url, 文件名)。

    Raises:
        RuntimeError: 网络异常或未找到 Windows 安装包。
    """
    try:
        req = urllib.request.Request(OBSIDIAN_RELEASE_API, headers={'User-Agent': 'vault-api-bridge'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            release = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        raise RuntimeError(f'查询 Obsidian 最新版本失败（网络或接口异常）: {e}')

    tag = release.get('tag_name', '')  # 例如 v1.6.7
    for asset in release.get('assets') or []:
        name = asset.get('name', '')
        if name.lower().endswith('.exe'):
            return asset.get('browser_download_url', ''), name

    # 接口没有 .exe 资产时，用官方下载 URL 模式兜底
    version = tag.lstrip('v')
    if version:
        url = f'https://github.com/obsidianmd/obsidian-releases/releases/download/{tag}/Obsidian-{version}.exe'
        return url, f'Obsidian-{version}.exe'

    raise RuntimeError('未能从 Obsidian GitHub Releases 找到 Windows 安装包')


def download_obsidian(dest_dir: Optional[str] = None) -> Dict:
    """下载 Obsidian 最新 Windows 安装包。

    注意：下载是外向动作，调用前必须先征得用户同意。

    Args:
        dest_dir: 下载目录，缺省为系统「下载」目录。

    Returns:
        {'status': 'success'|'error', 'file': ..., 'size_mb': ...} 或错误信息。
    """
    if os.name != 'nt':
        return {
            'status': 'error',
            'message': '本下载功能仅支持 Windows 安装包。macOS/Linux 请到 https://obsidian.md/download 手动下载。',
        }

    if dest_dir is None:
        dest_dir = str(pathlib.Path.home() / 'Downloads')
    dest_dir = pathlib.Path(dest_dir)
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return {'status': 'error', 'message': f'无法创建下载目录 {dest_dir}: {e}'}

    try:
        url, filename = _latest_windows_installer_url()
    except RuntimeError as e:
        return {'status': 'error', 'message': str(e)}

    dest = dest_dir / filename
    if dest.exists():
        return {'status': 'error', 'message': f'安装包已存在: {dest}（如需重下请先删除）'}

    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'vault-api-bridge'})
        print(f'[info] 正在下载 {filename} ...')
        with urllib.request.urlopen(req, timeout=120) as resp, open(dest, 'wb') as out:
            total = int(resp.headers.get('Content-Length') or 0)
            downloaded = 0
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = downloaded * 100 // total
                    print(f'\r[info] 下载进度: {pct}%', end='', flush=True)
        print()
    except Exception as e:
        # 清理半成品文件
        if dest.exists():
            dest.unlink()
        return {'status': 'error', 'message': f'下载失败: {e}'}

    return {
        'status': 'success',
        'file': str(dest),
        'size_mb': round(dest.stat().st_size / 1024 / 1024, 1),
        'message': '下载完成，请运行该安装包完成 Obsidian 安装。',
    }


# ---------------------------------------------------------------------------
# 命令行入口
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser(description='Obsidian 环境探测与初始化（vault-api-bridge）')
    parser.add_argument('--pick-vault', action='store_true', help='只输出默认仓库绝对路径')
    parser.add_argument('--download', action='store_true', help='下载 Obsidian 安装包（需已获用户同意）')
    parser.add_argument('--dest', default=None, help='下载目录（配合 --download）')
    args = parser.parse_args()

    if args.pick_vault:
        vault = pick_default_vault()
        print(vault['path'] if vault else '')
        sys.exit(0 if vault else 1)

    if args.download:
        result = download_obsidian(args.dest)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        sys.exit(0 if result['status'] == 'success' else 1)

    report = setup_check()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
