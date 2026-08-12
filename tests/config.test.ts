/**
 * 记忆目录定位测试（第 3 期补充：THATPERSON_MEMORY_DIR > 项目模式 > ~/.thatperson/history）
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
  getConfigValue,
  hasApiKey,
  isProjectMode,
  isSkillDisabled,
  listDisabledSkills,
  loadConfig,
  memoryRoot,
  resolveHistoryDir,
  setConfigValue,
} from '../src/config';
import { listSkills } from '../src/skill';
import { isolateHome } from './helpers';

const iso = isolateHome();
test.after(() => iso.restore());

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'thatperson-cfg-'));
}

test('isProjectMode：cwd 为本项目（package.json name=ThatPerson）时为 true', () => {
  const root = makeTmpRoot();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ThatPerson' }), 'utf8');
  assert.equal(isProjectMode(root), true);
  assert.equal(isProjectMode(makeTmpRoot()), false, '空目录不应判定为项目模式');
});

test('isProjectMode：存在本项目源码特征也判定为项目模式', () => {
  const root = makeTmpRoot();
  fs.mkdirSync(path.join(root, 'src', 'parser'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'parser', 'archive.ts'), '// probe', 'utf8');
  assert.equal(isProjectMode(root), true);
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

test('memoryRoot：项目模式用 cwd，全局模式用 THATPERSON_HOME', () => {
  const proj = makeTmpRoot();
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'ThatPerson' }), 'utf8');
  const home = makeTmpRoot();
  const savedHome = process.env.THATPERSON_HOME;
  process.env.THATPERSON_HOME = home;
  try {
    assert.equal(memoryRoot(proj), proj, '项目模式记忆根应为项目目录');
    const elsewhere = makeTmpRoot();
    assert.equal(memoryRoot(elsewhere), home, '非项目目录应回退到全局数据目录');
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
  assert.equal(CONFIG_KEY_WHITELIST.length, 2, '白名单应仅含 model 与 disabledSkills');
  const badKey = setConfigValue('apiKey', 'some-value');
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

test('config：api-key 引导文案不含硬编码 Key，无 Key 判定正确', () => {
  const saved = process.env.AAGENTDS_API_KEY;
  delete process.env.AAGENTDS_API_KEY;
  try {
    assert.equal(hasApiKey(), false);
    const guidance = apiKeyGuidance();
    assert.ok(guidance.includes('AAGENTDS_API_KEY'));
    assert.ok(guidance.includes('.env'));
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(guidance), '引导文案不得包含疑似硬编码 Key');
  } finally {
    if (saved === undefined) delete process.env.AAGENTDS_API_KEY;
    else process.env.AAGENTDS_API_KEY = saved;
  }
});
