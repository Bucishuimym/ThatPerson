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
  assert.equal(CONFIG_KEY_WHITELIST.length, 3, '白名单应含 model / disabledSkills / apiKey');
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

test('第5期：resetConfig 仅保留 model 与 apiKey（清 disabledSkills、configured 置 false）', () => {
  const home = makeTmpRoot();
  const savedHome = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    ensureConfigDir();
    setConfigValue('disabledSkills', 'code-op,prompt-op');
    setConfigValue('apiKey', 'sk-reset-abcdef12');
    setConfigValue('model', 'deepseek-chat');
    const res = resetConfig();
    assert.equal(res.ok, true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['apiKey', 'model'], 'reset 后仅保留 model+apiKey');
    assert.equal(onDisk.model, 'deepseek-chat');
    assert.equal(onDisk.apiKey, 'sk-reset-abcdef12');
    assert.equal(isConfigured(), false, 'reset 后 configured 缺省为 false');
  } finally {
    if (savedHome === undefined) delete process.env.THATPERSON_HOME;
    else process.env.THATPERSON_HOME = savedHome;
  }
});
