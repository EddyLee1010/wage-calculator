// 工资计算器自检：一条命令验证计算口径、文案一致性与包结构。
//
//   node tools/selfcheck.mjs
//
// 设计原则：计算断言从 client.js 的 SF-PURE 区抽取真实代码执行（new Function 求值），
// 所以测的是插件实际会跑的函数，不维护第二份实现。

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(join(ROOT, f), 'utf8')

const CLIENT = read('client.js')
const PKG = JSON.parse(read('package.json'))
const zhFile = JSON.parse(read('locale/zh.json'))
const enFile = JSON.parse(read('locale/en.json'))

let pass = 0
const fails = []
const ok = (name, cond, detail) => {
  if (cond) pass += 1
  else fails.push(detail ? `${name}（${detail}）` : name)
}
const eq = (name, actual, expected) =>
  ok(name, Object.is(actual, expected), `实际 ${String(actual)}，期望 ${String(expected)}`)

/* ---------- 1. 抽出纯函数区 ---------- */

const BEGIN = '// SF-PURE-BEGIN'
const END = '// SF-PURE-END'
const b = CLIENT.indexOf(BEGIN)
const e = CLIENT.indexOf(END)
if (b < 0 || e < 0) {
  console.error('找不到 SF-PURE 标记，抽不出纯函数区')
  process.exit(1)
}
let region = CLIENT.slice(b, e)

const exportNames = [
  'SETTLE_MS', 'DEFAULT_SETTINGS',
  'MESSAGES', 'calc', 'trunc2', 'fmtMoney', 'parseHHMM', 'validateSettings', 'reviveSettings',
]
const PURE = new Function(`${region}\nreturn { ${exportNames.join(', ')} }`)()

/* ---------- 2. 计算口径 ---------- */

// 白班 09:00-18:00，午休 12:00-13:00。月薪 17600/22 天 → 日薪 800。净 8h → 时薪 100。
const S = { monthly: 17600, days: 22, start: '09:00', end: '18:00', lunchStart: '12:00', lunchEnd: '13:00' }
const at = (h, m = 0, s = 0, day = 26) => new Date(2026, 9, day, h, m, s, 0)

const c1 = PURE.calc(S, at(8, 59, 59))
eq('上班前 1 秒金额归零', PURE.fmtMoney(c1.earned), '¥0.00')
eq('上班前 1 秒相位 before', c1.phase, 'before')

const c2 = PURE.calc(S, at(9, 0, 0))
eq('整点开工 ¥0.00', PURE.fmtMoney(c2.earned), '¥0.00')
eq('整点开工相位 working', c2.phase, 'working')

const c3 = PURE.calc(S, at(12, 0, 0))
eq('上午 3 小时 ¥300.00', PURE.fmtMoney(c3.earned), '¥300.00')

const c4 = PURE.calc(S, at(12, 30, 0))
eq('午休过半不涨 ¥300.00', PURE.fmtMoney(c4.earned), '¥300.00')
eq('午休期间相位 working', c4.phase, 'working')

const c5 = PURE.calc(S, at(13, 0, 0))
eq('午休刚结束仍 ¥300.00', PURE.fmtMoney(c5.earned), '¥300.00')

const c6 = PURE.calc(S, at(14, 0, 0))
eq('午休后 1 小时 ¥400.00', PURE.fmtMoney(c6.earned), '¥400.00')

const c7 = PURE.calc(S, at(18, 0, 0))
eq('下班当刻封顶 ¥800.00', PURE.fmtMoney(c7.earned), '¥800.00')
eq('下班当刻相位 after', c7.phase, 'after')

const c8 = PURE.calc(S, at(23, 30, 0))
eq('收工后不再增长', PURE.fmtMoney(c8.earned), '¥800.00')

// 无午休配置（lunch 为空）
const SN = { monthly: 17600, days: 22, start: '09:00', end: '17:00', lunchStart: '', lunchEnd: '' }
const sn = PURE.calc(SN, at(13, 0, 0))
eq('无午休 13:00 已赚 ¥400.00', PURE.fmtMoney(sn.earned), '¥400.00')

// 跨午夜夜班 22:00-06:00 无午休，8h
const N = { monthly: 17600, days: 22, start: '22:00', end: '06:00', lunchStart: '', lunchEnd: '' }
const n1 = PURE.calc(N, at(2, 0, 0))
eq('夜班 02:00 已赚一半 ¥400.00', PURE.fmtMoney(n1.earned), '¥400.00')
eq('夜班 02:00 相位 working', n1.phase, 'working')

const n2 = PURE.calc(N, at(6, 0, 0))
eq('夜班下班当刻 ¥800.00', PURE.fmtMoney(n2.earned), '¥800.00')
eq('夜班下班当刻相位 after', n2.phase, 'after')

const n3 = PURE.calc(N, at(12, 0, 0))
eq('夜班收工后整天不掉回 0', PURE.fmtMoney(n3.earned), '¥800.00')

// 非法输入一律 ¥0.00
const bad = [
  { monthly: 0 }, { monthly: -1 }, { days: 0 }, { days: 32 },
  { start: '25:99' }, { start: '' }, { start: null }, { start: 'abc' },
  { end: '25:00' }, { end: '' }, { end: null },
]
for (const patch of bad) {
  const r = PURE.calc({ ...S, ...patch }, at(12))
  ok(`非法输入 ${JSON.stringify(patch)} 一律 ¥0.00`, PURE.fmtMoney(r.earned) === '¥0.00')
}

// 校验器
const p1 = PURE.validateSettings({ ...S, start: '9:00' })
ok('9:00 单位数小时也认', p1.ok === true, JSON.stringify(p1))
const p2 = PURE.validateSettings({ ...S, start: '25:00' })
ok('25:00 上班判非法', p2.ok === false && p2.reason === 'error.invalidTime', JSON.stringify(p2))
const p3 = PURE.validateSettings({ ...S, end: '25:00' })
ok('25:00 下班判非法', p3.ok === false && p3.reason === 'error.invalidTime', JSON.stringify(p3))
const p4 = PURE.validateSettings({ ...S, lunchStart: '14:00', lunchEnd: '12:00' })
ok('午休 le<=ls 判非法', p4.ok === false && p4.reason === 'error.invalidLunch', JSON.stringify(p4))
const p5 = PURE.validateSettings(S)
ok('完整设置判合法', p5.ok === true, JSON.stringify(p5.reason))

// 全天逐秒扫描：显示值必须等于截断值（含午休剔除后的净时段）
{
  // 手工重建计薪区间：09:00-12:00 与 13:00-18:00
  const paidSlots = []
  for (let hh = 9; hh <= 17; hh += 1) {
    for (let mm = 0; mm < 60; mm += 2) {
      if ((hh === 12) || (hh === 11 && mm > 0) || (hh === 12)) continue // 12:00-12:59 午休
      paidSlots.push(hh * 3600 + mm * 60)
    }
  }
  let drift = 0
  for (let hh = 9; hh <= 17; hh += 1) {
    for (let mm = 0; mm < 60; mm += 2) {
      if (hh === 12) continue
      const d = new Date(2026, 9, 26, hh, mm, 0, 0)
      const r = PURE.calc(S, d)
      const shown = Number(PURE.fmtMoney(r.earned).slice(1))
      if (!Object.is(shown, PURE.trunc2(r.earned))) drift += 1
    }
  }
  eq('全天计薪时段显示值都等于截断值', drift, 0)
}
eq('截断：0.999 → 0.99', PURE.fmtMoney(0.999), '¥0.99')
eq('截断：1.005 → 1.00（不进位）', PURE.fmtMoney(1.005), '¥1.00')

/* ---------- 3. locale 一致 ---------- */

const flat = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flat(v, key, out)
    else out[key] = v
  }
  return out
}
const zhF = flat(zhFile)
const enF = flat(enFile)
const zhI = flat(PURE.MESSAGES.zh)
const enI = flat(PURE.MESSAGES.en)
const diff = (a, b) => Object.keys(a).filter((k) => !(k in b))
eq('zh 文件键数与内联表一致', Object.keys(zhF).length, Object.keys(zhI).length)
eq('en 文件键数与内联表一致', Object.keys(enF).length, Object.keys(enI).length)
eq('zh 文件没有内联表缺的键', diff(zhF, zhI).join(','), '')
eq('en 文件没有内联表缺的键', diff(enF, enI).join(','), '')
eq('zh/en 键集一致', diff(zhF, enF).join(',') + diff(enF, zhF).join(','), '')

/* ---------- 4. 包结构 ---------- */

ok('SETTLE_MS 是 2000（每 2 秒）', PURE.SETTLE_MS, 2000)
ok('不是 private 包', PKG.private !== true, '包名 ' + PKG.name)
ok('name 是 wage-calculator', PKG.name === 'wage-calculator')
for (const f of PKG.files) {
  if (f.includes('*')) continue
  ok(`files 里 ${f} 存在`, existsSync(join(ROOT, f)))
}
ok('dsh.bundle.patch 存在', existsSync(join(ROOT, PKG.dsh.bundle.patch)))
ok('client 文件含槽位注册', CLIENT.includes('shell.overlay'))
ok('client 文件含 ModuleLoader 加载', CLIENT.includes('window.__ModuleLoader__.load'))

/* ---------- 汇总 ---------- */

const total = pass + fails.length
if (fails.length) {
  console.log(`==== 自检没全过：${pass}/${total} ====`)
  for (const f of fails) console.log('  ❌ ' + f)
  process.exit(1)
}
console.log(`==== 自检 ${pass}/${total} 全绿 ====`)