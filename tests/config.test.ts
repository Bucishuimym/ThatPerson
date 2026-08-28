/**
 * 配置与目录定位测试（第 3 期补充：THATPERSON_MEMORY_DIR > 随身目录 > ~/.thatperson/history；
 * 第 5 期批次一：apiKey 同源、configured 标记、resetConfig、主/随身目录定位模型）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_KEY_WHITELIST,
  apiKeyGuidance,
  disableSkill,
  enableSkill,
  ensureConfigDir,
  getConfigValue,
  hasApiKey,
  isConfigured,
  isProjectMode,
  isSkillDisabled,
  listDisabledSkills,
  loadConfig,
  localThatPersonDir,
  memoryRoot,
  resolveApiKey,
  resolveHistoryDir,
  resetConfig,
  setConfigValue,
} from '../src/config';
import { listSkills } from '../src/skill';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-cfg-'));
}

test('localThatPersonDir/isProjectMode：cwd 存在 .thatperson 目录时判定为随身目录', () => {
  const root = makeTmpRoot();
  fs.mkdirSync(path.join(root, '.thatperson'), { recursive: true });
  assert.equal(localThatPersonDir(root), path.resolve(root, '.thatperson'), '应返回随身目录绝对路径');
  assert.equal(isProjectMode(root), true, 'isProjectMode 兼容导出 = 随身目录判定');
});

test('localThatPersonDir：无 .thatperson 目录返回 null（仅凭 package.json 名称不判定）', () => {
  const root = makeTmpRoot();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ThatPerson' }), 'utf8');
  assert.equal(localThatPersonDir(root), null, '仅凭 package.json 名称不应判定为随身目录');
  assert.equal(isProjectMode(makeTmpRoot()), false, '空目录不应判定为随身目录');
});

test('memoryRoot：THATPERSON_MEMORY_DIR 显式指定时取其父目录', () => {
  const root = makeTmpRoot();
  const hist = path.join(root, 'my', 'history');
  process.env.THATPERSON_MEMORY_DIR = hist;
  try {
    assert.equal(memoryRoot(root), path.join(root, 'my'));
    assert.equal(resolveHistoryDir(root), hist);
  } finally {
    delete process.env.THATPERSON_MEMORY_DIR;
  }
});

test('memoryRoot：随身目录（cwd/.thatperson 存在）优先，否则回退 THATPERSON_HOME', () => {
  const portable = makeTmpRoot();
  fs.mkdirSync(path.join(portable, '.thatperson'), { recursive: true });
  const home = makeTmpRoot();
  const savedHome = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    assert.equal(memoryRoot(portable), path.resolve(portable, '.thatperson'), '随身目录模式记忆根应为 .thatperson');
    assert.equal(resolveHistoryDir(portable), path.join(path.resolve(portable, '.thatperson'), 'history'));
    const elsewhere = makeTmpRoot();
    assert.equal(memoryRoot(elsewhere), home, '非随身目录应回退到全局数据目录');
    assert.equal(resolveHistoryDir(elsewhere), path.join(home, 'history'));
  } finally {
    if (savedHome === undefined) delete process.env.THATPERSON_HOME;
    else process.env.THATPERSON_HOME = savedHome;
  }
});

// ===== 第 6 期批次二 · allow-dir 授权持久化（D-4 测试先行，红态契约；allowDir/denyDir 尚未实现，经命名空间断言调用） =====
import * as configB2Module from '../src/config';

type B2DirResult = { ok: true } | { ok: false; error: string };
const configB2 = configB2Module as unknown as {
  allowDir(dir: string): B2DirResult;
  denyDir(dir: string): B2DirResult;
};

/** 读 config.json 落盘内容（批次二契约：allowedDirs 持久化） */
function readConfigOnDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(iso.home, 'config.json'), 'utf8')) as Record<string, unknown>;
}

function allowedDirsOnDisk(): string[] {
  const raw = readConfigOnDisk().allowedDirs;
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string') : [];
}

/** 清理 allowedDirs（直接写盘，不依赖 denyDir 当前是否实现） */
function resetConfigFile(): void {
  fs.writeFileSync(
    path.join(iso.home, 'config.json'),
    `${JSON.stringify({ model: 'deepseek-v4-flash', disabledSkills: [], configured: false }, null, 2)}\n`,
    'utf8',
  );
}

test('第6期批次二 allowDir：授权真实目录并持久化，重复添加幂等', () => {
  const dir = makeTmpRoot();
  try {
    assert.equal(configB2.allowDir(dir).ok, true, '首次授权应成功');
    assert.equal(configB2.allowDir(dir).ok, true, '重复授权应成功（幂等）');
    const dirs = allowedDirsOnDisk();
    assert.ok(dirs.includes(path.resolve(dir)), 'allowedDirs 应包含已授权目录');
    assert.equal(
      dirs.filter((d) => path.resolve(d) === path.resolve(dir)).length,
      1,
      '重复添加不得产生重复条目',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    resetConfigFile();
  }
});

test('第6期批次二 allowDir：相对路径/不存在/非目录/含 .. 注入一律拒绝', () => {
  const root = makeTmpRoot();
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, 'x', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(root, 'escape'), { recursive: true });
  const rel = 'relative-dir';
  const missing = path.join(root, 'no-such-dir');
  const dotdot = `${root}${path.sep}sub${path.sep}..${path.sep}escape`; // 含 .. 段的原始输入，必须拒绝（path.join 会折叠，需保留字面 ..）
  try {
    for (const bad of [rel, missing, file, dotdot]) {
      const res = configB2.allowDir(bad);
      assert.equal(res.ok, false, `非法路径应拒绝：${bad}`);
      if (!res.ok) assert.ok(res.error.length > 0, '拒绝应带原因');
    }
    assert.equal(allowedDirsOnDisk().length, 0, '非法路径不得写入 allowedDirs');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    resetConfigFile();
  }
});

test('第6期批次二 denyDir：对称移除授权，保留其余授权，重复移除幂等', () => {
  const a = makeTmpRoot();
  const b = makeTmpRoot();
  try {
    assert.equal(configB2.allowDir(a).ok, true);
    assert.equal(configB2.allowDir(b).ok, true);
    assert.equal(allowedDirsOnDisk().length, 2);
    assert.equal(configB2.denyDir(a).ok, true, 'denyDir 应成功移除');
    const dirs = allowedDirsOnDisk();
    assert.ok(dirs.includes(path.resolve(b)), '移除后其余授权应保留');
    assert.ok(!dirs.includes(path.resolve(a)), '被移除目录不应再出现');
    assert.equal(configB2.denyDir(a).ok, true, '重复移除应幂等');
    assert.equal(configB2.denyDir(path.join(a, 'ghost')).ok, true, '移除未授权目录应幂等成功');
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
    resetConfigFile();
  }
});

test('第6期批次二 resetConfig：保留 allowedDirs（disabledSkills 清理、configured 置 false）', () => {
  const home = makeTmpRoot();
  const savedHome = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    ensureConfigDir();
    const dir = makeTmpRoot();
    try {
      assert.equal(configB2.allowDir(dir).ok, true);
      assert.equal(setConfigValue('disabledSkills', 'code-op,prompt-op').ok, true);
      assert.equal(setConfigValue('apiKey', 'sk-reset-b2-abcdef').ok, true);
      const res = resetConfig();
      assert.equal(res.ok, true);
      const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<string, unknown>;
      assert.ok(Array.isArray(onDisk.allowedDirs), 'reset 后 allowedDirs 应保留');
      assert.ok((onDisk.allowedDirs as string[]).includes(path.resolve(dir)), '授权目录应保留');
      assert.equal(onDisk.apiKey, 'sk-reset-b2-abcdef', 'apiKey 应保留');
      assert.equal(onDisk.configured, false, 'configured 应置 false');
      assert.equal(onDisk.disabledSkills, undefined, 'disabledSkills 应被清理');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (savedHome === undefined) delete process.env.THATPERSON_HOME;
    else process.env.THATPERSON_HOME = savedHome;
  }
});


// ===== 第 4 期（D-3b）：config get/set 与 skills 启停 =====

test('config：默认含 disabledSkills: []，loadConfig 不覆盖既有文件的其他字段', () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.disabledSkills, []);
  assert.equal(cfg.model, 'deepseek-v4-flash');
  const configPath = path.join(iso.home, 'config.json');
  assert.ok(fs.existsSync(configPath), 'ensureConfigDir 应生成默认 config.json');
  fs.writeFileSync(configPath, JSON.stringify({ model: 'custom-model', extraField: 1 }), 'utf8');
  const again = loadConfig();
  assert.equal(again.model, 'custom-model');
  assert.deepEqual(again.disabledSkills, []);
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.extraField, 1, '既有文件的其他字段应保留');
});

test('config set：model 写回且保留 disabledSkills 与其他字段', () => {
  const configPath = path.join(iso.home, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ model: 'a', disabledSkills: ['x'], extraField: 2 }), 'utf8');
  const res = setConfigValue('model', 'deepseek-chat');
  assert.equal(res.ok, true);
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(onDisk.model, 'deepseek-chat');
  assert.deepEqual(onDisk.disabledSkills, ['x']);
  assert.equal(onDisk.extraField, 2, 'set 不得覆盖其他字段');
});

test('config set：非法 key 与空值拒绝', () => {
  assert.ok(CONFIG_KEY_WHITELIST.includes('model'));
  assert.ok(CONFIG_KEY_WHITELIST.includes('disabledSkills'));
  assert.ok(CONFIG_KEY_WHITELIST.includes('apiKey'));
  assert.ok(CONFIG_KEY_WHITELIST.includes('allowedDirs'), '白名单应含 allowedDirs（第 6 期批次二）');
  assert.ok(CONFIG_KEY_WHITELIST.length >= 4, '白名单应含 model / disabledSkills / apiKey / allowedDirs');
  const badKey = setConfigValue('secret', 'some-value');
  if (badKey.ok) assert.fail('非法 key 应拒绝');
  else assert.match(badKey.error, /不支持的配置键/);
  const empty = setConfigValue('model', '   ');
  if (empty.ok) assert.fail('空值应拒绝');
  else assert.match(empty.error, /不能为空/);
});

test('config set：disabledSkills 支持 JSON 数组与逗号/顿号分隔', () => {
  const arr = setConfigValue('disabledSkills', '["code-op", "Prompt-OP"]');
  assert.equal(arr.ok, true);
  assert.deepEqual(listDisabledSkills(), ['code-op', 'prompt-op'], '应小写、去重');
  const csv = setConfigValue('disabledSkills', 'a,b、c');
  assert.equal(csv.ok, true);
  assert.deepEqual(listDisabledSkills(), ['a', 'b', 'c']);
});

test('config set：损坏的 config.json 拒绝写回（不静默覆盖既有文件）', () => {
  const configPath = path.join(iso.home, 'config.json');
  fs.writeFileSync(configPath, '{broken json', 'utf8');
  const res = setConfigValue('model', 'x');
  if (res.ok) assert.fail('损坏配置应拒绝写回');
  else assert.match(res.error, /无法解析/);
  assert.ok(fs.readFileSync(configPath, 'utf8').includes('broken'), '损坏文件内容不得被覆盖');
  fs.writeFileSync(configPath, JSON.stringify({ model: 'deepseek-v4-flash', disabledSkills: [] }), 'utf8');
});

test('skills：disable/enable 持久化到 disabledSkills，listSkills 过滤已禁用', () => {
  const skillsDir = makeTmpRoot();
  fs.mkdirSync(path.join(skillsDir, 'demo-skill'), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示技能\n---\n正文\n',
    'utf8',
  );
  assert.equal(listSkills([skillsDir]).some((s) => s.name === 'demo-skill'), true);

  const dis = disableSkill('Demo-Skill'); // 大小写不敏感
  assert.equal(dis.ok, true);
  assert.ok(isSkillDisabled('demo-skill'));
  assert.deepEqual(listDisabledSkills(), ['demo-skill']);
  assert.equal(listSkills([skillsDir]).some((s) => s.name === 'demo-skill'), false, '已禁用技能应被过滤');

  const en = enableSkill('demo-skill');
  assert.equal(en.ok, true);
  assert.equal(isSkillDisabled('demo-skill'), false);
  assert.equal(listSkills([skillsDir]).some((s) => s.name === 'demo-skill'), true, '重新启用后应恢复');
});

test('config：getConfigValue 白名单键读取', () => {
  const res = setConfigValue('model', 'deepseek-v4-flash');
  assert.equal(res.ok, true);
  assert.equal(getConfigValue('model'), 'deepseek-v4-flash');
  assert.deepEqual(getConfigValue('disabledSkills'), []);
});

test('config：api-key 引导文案指向 setup 向导，无 Key 判定正确', () => {
  // 先恢复纯净 config（避免被 apiKey 用例污染，保证 hasApiKey 仅反映环境变量）
  fs.writeFileSync(
    path.join(iso.home, 'config.json'),
    JSON.stringify({ model: 'deepseek-v4-flash', disabledSkills: [], configured: false }),
    'utf8',
  );
  const saved = process.env.AAGENTDS_API_KEY;
  delete process.env.AAGENTDS_API_KEY;
  try {
    assert.equal(hasApiKey(), false);
    const guidance = apiKeyGuidance();
    assert.ok(guidance.includes('thatperson setup'), '应指向 setup 向导');
    assert.ok(guidance.includes('config set apiKey'), '应提及 config set apiKey 备选');
    assert.ok(!guidance.includes('.env'), '不再引导工作目录建 .env');
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(guidance), '引导文案不得包含疑似硬编码 Key');
  } finally {
    if (saved === undefined) delete process.env.AAGENTDS_API_KEY;
    else process.env.AAGENTDS_API_KEY = saved;
  }
});

// ===== 第 5 期（批次一）：apiKey 同源 / configured / reset / 0600 =====

test('第5期：resolveApiKey 优先级 = 环境变量 > config.json.apiKey', () => {
  const saved = process.env.AAGENTDS_API_KEY;
  delete process.env.AAGENTDS_API_KEY;
  try {
    const set = setConfigValue('apiKey', 'sk-config-abcdef');
    assert.equal(set.ok, true);
    assert.equal(resolveApiKey(), 'sk-config-abcdef', '无环境变量时读 config.json.apiKey');
    process.env.AAGENTDS_API_KEY = 'sk-env-12345678';
    assert.equal(resolveApiKey(), 'sk-env-12345678', '环境变量应优先于 config.json.apiKey');
    assert.equal(hasApiKey(), true, 'hasApiKey 走 resolveApiKey 同源');
  } finally {
    if (saved === undefined) delete process.env.AAGENTDS_API_KEY;
    else process.env.AAGENTDS_API_KEY = saved;
  }
  // 恢复纯净 config（避免污染后续用例）
  fs.writeFileSync(
    path.join(iso.home, 'config.json'),
    JSON.stringify({ model: 'deepseek-v4-flash', disabledSkills: [], configured: false }),
    'utf8',
  );
});

test('第5期：config.json 首次写盘 0600（POSIX 权限位）', { skip: process.platform === 'win32' }, () => {
  const home = makeTmpRoot();
  const savedHome = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    ensureConfigDir();
    const mode = fs.statSync(path.join(home, 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600, 'config.json 权限应为 0600');
  } finally {
    if (savedHome === undefined) delete process.env.THATPERSON_HOME;
    else process.env.THATPERSON_HOME = savedHome;
  }
});

test('第5期：config.json 首次创建含 configured:false，写入 apiKey 后 configured 置 true', () => {
  const home = makeTmpRoot();
  const savedHome = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    ensureConfigDir();
    const first = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(first.configured, false, '首次创建应含 configured:false');
    assert.equal(isConfigured(), false, '未配置时 isConfigured 为 false');
    const res = setConfigValue('apiKey', 'sk-setup-abcdef12');
    assert.equal(res.ok, true);
    assert.equal(isConfigured(), true, '写入 apiKey 后视为已配置');
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(onDisk.apiKey, 'sk-setup-abcdef12');
    assert.equal(onDisk.configured, true);
  } finally {
    if (savedHome === undefined) delete process.env.THATPERSON_HOME;
    else process.env.THATPERSON_HOME = savedHome;
  }
});

test('第5期：resetConfig 保留 model/apiKey/allowedDirs，清 disabledSkills、configured 置 false', () => {
  const home = makeTmpRoot();
  const savedHome = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    ensureConfigDir();
    setConfigValue('disabledSkills', 'code-op,prompt-op');
    setConfigValue('apiKey', 'sk-reset-abcdef12');
    setConfigValue('model', 'deepseek-chat');
    const granted = makeTmpRoot();
    assert.equal(configB2.allowDir(granted).ok, true, '授权目录应成功');
    const res = resetConfig();
    assert.equal(res.ok, true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    fs.rmSync(granted, { recursive: true, force: true });
    assert.equal(onDisk.model, 'deepseek-chat');
    assert.equal(onDisk.apiKey, 'sk-reset-abcdef12');
    assert.ok(Array.isArray(onDisk.allowedDirs) && onDisk.allowedDirs.includes(path.resolve(granted)), 'reset 后应保留 allowedDirs');
    assert.equal(onDisk.configured, false, 'reset 后显式写 configured:false');
    assert.equal(onDisk.disabledSkills, undefined, 'reset 后应清除 disabledSkills');
    assert.equal(isConfigured(), false, 'reset 后 configured 缺省为 false');
  } finally {
    if (savedHome === undefined) delete process.env.THATPERSON_HOME;
    else process.env.THATPERSON_HOME = savedHome;
  }
});
