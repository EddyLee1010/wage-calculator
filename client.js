/**
 * 「工资计算器」浏览器半边。
 *
 * 一块挂在 `shell.overlay` 上的工资看板：填月薪 / 每月工作天数 / 上下班时间 / 午休，
 * 每 `SETTLE_MS`(1000ms) 结算一次「今天已经赚了多少钱」，午休期间停摆不计薪，
 * 下班后封顶为日薪。金额一律两位小数截断。
 *
 * 结构分区：
 *   1. 常量区     —— 时间常数、localStorage 键名、默认参数、内联文案。
 *   2. 纯函数区   —— 计算口径（calc 等）。不依赖 React/DOM，可抠出来跑自检。
 *   3. hook 区    —— 秒表、持久化、语言、减动态效果。
 *   4. 组件区     —— 设置卡 / 运行看板 / 根组件。
 *   5. 注册区     —— 通过 `shell.overlay` 槽位注入。
 *
 * 运行铁律：
 *   - 渲染路径绝不抛错：读盘 / JSON.parse / 数字 / 时间串全部先校验，非法一律回安全默认。
 *   - hooks 全部无条件调用，两态只是 return 里的分支。
 *   - 外层容器 pointer-events:none，卡片本体 pointer-events:auto。
 */

window.__ModuleLoader__.load({
  id: 'wage-calculator',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    // ==========================================================================
    // SF-PURE-BEGIN  ↓↓↓ 单测抽取区（常量 + 纯函数，无 React/DOM 依赖）
    // ==========================================================================

    // ==========================================================================
    // 1. 常量区
    // ==========================================================================

    /** 结算节拍：每 2 秒一次。 */
    const SETTLE_MS = 2000
    /** 收工后的低频节拍：只用来「跨天醒来」，60 秒一跳够用。 */
    const IDLE_MS = 60000
    /** 拖动判定阈值：位移超过 3px 才算拖动，否则当点击。 */
    const DRAG_THRESHOLD = 3

    /** localStorage 键名统一前缀。几个键分开存，互不牵连。 */
    const LS_PREFIX = 'dsh.wage-calculator.v1.'
    const LS_SETTINGS = LS_PREFIX + 'settings'
    const LS_POS = LS_PREFIX + 'pos'
    const LS_LANG = LS_PREFIX + 'lang'
    const LS_HIDDEN = LS_PREFIX + 'hidden'

    /** 首次出现的默认设置。 */
    const DEFAULT_SETTINGS = {
      monthly: 12000,
      days: 22,
      start: '09:00',
      end: '18:00',
      lunchStart: '12:00',
      lunchEnd: '13:00',
    }
    /** 一天的分钟数。 */
    const MINUTES_PER_DAY = 1440

    /** 看板几何：默认落右下角。 */
    const CARD_W = 280
    const EDGE = 12
    const DEFAULT_INSET = { right: 24, bottom: 96 }

    // 面板高度兜底值（真实高度由 ResizeObserver 量，失效才用它）。
    const H_SETUP = 360
    const H_RUNNING = 172

    /**
     * 数值夹紧；NaN / 非有限值一律退 lo。
     */
    function clampNum(v, lo, hi) {
      const n = Number(v)
      const low = Number.isFinite(lo) ? lo : 0
      const high = Number.isFinite(hi) ? hi : low
      if (!Number.isFinite(n)) return low
      if (n < low) return low
      if (n > high) return high
      return n
    }

    /**
     * 'HH:mm' -> 当天 0 点起的分钟数；非法输入返回 null。
     */
    function parseHHMM(s) {
      if (typeof s !== 'string') return null
      const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
      if (!m) return null
      const hh = Number(m[1])
      const mm = Number(m[2])
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
      if (hh < 0 || hh > 23) return null
      if (mm < 0 || mm > 59) return null
      return hh * 60 + mm
    }

    /** 'HH:mm'（带前导零）。 */
    function fmtHHMM(minutes) {
      const hh = Math.floor(minutes / 60)
      const mm = minutes % 60
      return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0')
    }

    /** 数值读入：容忍千分位、空格、全角空格；空串/非法一律 NaN。 */
    function toNum(v) {
      if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
      const s = String(v === null || v === undefined ? '' : v).replace(/[,\uff0c\s]/g, '')
      if (s === '') return NaN
      const n = Number(s)
      return Number.isFinite(n) ? n : NaN
    }

    /** 一段已过长度 x 里，[lo, hi) 的时长（同单位，分钟）。 */
    function overlapTo(lo, hi, x) {
      if (x <= lo) return 0
      if (x >= hi) return hi - lo
      return x - lo
    }

    /**
     * 算今天赚了多少。
     *
     * 口径：日薪 = 月薪 / 每月工作天数；净工时 = (下班 − 上班) − 午休；
     * 时薪 = 日薪 / 净工时(小时)；进度 = 班次内已过计薪时长 / 净工时；
     * 今日已赚 = 日薪 × 进度。午休时段不计薪（看板停住）。下班后封顶=日薪。
     *
     * 跨午夜：end<start 视为跨午夜（如 22:00–06:00），shiftLen 补 24h。
     * 午休可选：留空 / 非法 / le≤ls 视为无午休，整段连续计薪。
     *
     * @param {{monthly:number,days:number,start:string,end:string,
     *          lunchStart?:string,lunchEnd?:string}} settings
     * @param {number} now 本机本地时间的 epoch ms
     * @returns {{earned:number,dailyWage:number,hourly:number,progress:number,
     *            phase:'before'|'working'|'after',nextStart:number}}
     */
    function calc(settings, now) {
      const empty = { earned: 0, dailyWage: 0, hourly: 0, progress: 0, phase: 'before', nextStart: 0 }
      try {
        const monthly = Number(settings && settings.monthly)
        const days = Number(settings && settings.days)
        const nowMs = Number(now)
        if (!Number.isFinite(monthly) || monthly <= 0) return empty
        if (!Number.isFinite(days) || days < 1 || days > 31) return empty
        if (!Number.isFinite(nowMs)) return empty

        const start = parseHHMM(settings && settings.start)
        const end = parseHHMM(settings && settings.end)
        const ls = parseHHMM(settings && settings.lunchStart)
        const le = parseHHMM(settings && settings.lunchEnd)
        if (start === null || end === null) return empty

        // 班次长度（分钟）；end≤start 视为跨午夜。
        let shiftLen = end - start
        if (shiftLen <= 0) shiftLen += MINUTES_PER_DAY

        // 净工时：扣掉完整落在班次内的午休。
        const lunchStartRel = ls === null ? null : ls - start
        const lunchEndRel = le === null ? null : le - start
        const hasLunch =
          lunchStartRel !== null &&
          lunchEndRel !== null &&
          lunchEndRel > lunchStartRel &&
          lunchStartRel >= 0 &&
          lunchEndRel <= shiftLen
        const lunchLen = hasLunch ? lunchEndRel - lunchStartRel : 0
        const netLen = shiftLen - lunchLen
        if (netLen <= 0) return empty // 净工时必须 >0

        const dailyWage = monthly / days
        const hourly = dailyWage / (netLen / 60)
        const netLenMs = netLen * 60000

        // 今天这个上班时刻的绝对时间戳。
        const d = new Date(nowMs)
        const y = d.getFullYear()
        const mo = d.getMonth()
        const da = d.getDate()
        const hh = Math.floor(start / 60)
        const mm = start % 60
        const todayStart = new Date(y, mo, da, hh, mm, 0, 0).getTime()

        // 班次窗口选择：跨午夜班次才可能处在昨天开始的那个窗口。
        const crossMidnight = start + shiftLen > MINUTES_PER_DAY
        let shiftStart = todayStart
        if (crossMidnight && nowMs < todayStart) {
          const prevStart = new Date(y, mo, da - 1, hh, mm, 0, 0).getTime()
          if (nowMs >= prevStart) shiftStart = prevStart
        }

        const raw = nowMs - shiftStart
        const shiftMs = shiftLen * 60000
        const elapsed = clampNum(raw, 0, shiftMs) // 班次内已过时刻（含午休）

        // 落进 [0, elapsed] 的午休时长；午休期间 elapsed 与 overlap 同步前进，
        // netElapsed 不动 → 金额停住。
        const lunchOverlap =
          hasLunch ? overlapTo(lunchStartRel * 60000, lunchEndRel * 60000, elapsed) : 0
        const netElapsed = elapsed - lunchOverlap
        const progress = netElapsed / netLenMs
        const phase = raw < 0 ? 'before' : raw >= shiftMs ? 'after' : 'working'

        // 下一次开工：今天没到用今天，否则顺延明天同一时刻。
        let nextStart = todayStart
        if (!(nextStart > nowMs)) nextStart = new Date(y, mo, da + 1, hh, mm, 0, 0).getTime()

        return { earned: dailyWage * progress, dailyWage, hourly, progress, phase, nextStart }
      } catch (err) {
        return empty
      }
    }

    /** 截断到两位小数（不四舍五入），带 1e-9 修正。绝不 NaN、绝不 -0。 */
    function trunc2(n) {
      if (!Number.isFinite(n)) return 0
      const v = Math.floor(Math.abs(n) * 100 + 1e-9) / 100
      return n < 0 && v !== 0 ? -v : v
    }

    /** 金额显示：固定 `¥12.34`，两位小数截断。 */
    function fmtMoney(n) {
      const v = trunc2(n)
      const safe = v === 0 ? 0 : v
      return '¥' + safe.toFixed(2)
    }

    /**
     * 校验设置：返回 { ok, reason, value }。value 在 ok 时是规范化的设置对象。
     * reason 是文案 key（error.*）。午休留空视为无午休；填一项没另一项、或 le≤ls 判非法。
     */
    function validateSettings(raw) {
      const monthly = toNum(raw && raw.monthly)
      const days = toNum(raw && raw.days)
      const start = raw && raw.start
      const end = raw && raw.end
      const lunchStart = raw && raw.lunchStart
      const lunchEnd = raw && raw.lunchEnd
      if (!Number.isFinite(monthly) || monthly <= 0) {
        return { ok: false, reason: 'error.invalidNumber', value: DEFAULT_SETTINGS }
      }
      if (!Number.isFinite(days) || days < 1 || days > 31) {
        return { ok: false, reason: 'error.invalidNumber', value: DEFAULT_SETTINGS }
      }
      if (parseHHMM(start) === null || parseHHMM(end) === null) {
        return { ok: false, reason: 'error.invalidTime', value: DEFAULT_SETTINGS }
      }
      const lunchBoth = !!(lunchStart && lunchEnd)
      const lunchValid = parseHHMM(lunchStart) !== null && parseHHMM(lunchEnd) !== null
      if (lunchBoth && !lunchValid) {
        return { ok: false, reason: 'error.invalidLunch', value: DEFAULT_SETTINGS }
      }
      if (lunchBoth && lunchValid && parseHHMM(lunchEnd) <= parseHHMM(lunchStart)) {
        return { ok: false, reason: 'error.invalidLunch', value: DEFAULT_SETTINGS }
      }
      return {
        ok: true,
        reason: '',
        value: {
          monthly,
          days,
          start,
          end,
          lunchStart: lunchBoth ? lunchStart : '',
          lunchEnd: lunchBoth ? lunchEnd : '',
        },
      }
    }

    /**
     * 读盘归一层：localStorage 里的 settings 可能是任何东西。逐字段校验、坏字段回默认。
     * 整体不是对象返回 null（= 无配置 → 设置态）。午休缺/空/非法 → 存 ''（无午休）。
     */
    function reviveSettings(parsed) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      const monthly = toNum(parsed.monthly)
      const days = toNum(parsed.days)
      const startOk = parseHHMM(parsed.start) !== null
      const endOk = parseHHMM(parsed.end) !== null
      const ls = parseHHMM(parsed.lunchStart)
      const le = parseHHMM(parsed.lunchEnd)
      const lunchBoth =
        typeof parsed.lunchStart === 'string' &&
        parsed.lunchStart.trim() !== '' &&
        typeof parsed.lunchEnd === 'string' &&
        parsed.lunchEnd.trim() !== ''
      const lunchKeep = lunchBoth && ls !== null && le !== null && le > ls
      return {
        monthly: Number.isFinite(monthly) && monthly > 0 ? monthly : DEFAULT_SETTINGS.monthly,
        days: Number.isFinite(days) && days >= 1 && days <= 31 ? days : DEFAULT_SETTINGS.days,
        start: startOk ? parsed.start : DEFAULT_SETTINGS.start,
        end: endOk ? parsed.end : DEFAULT_SETTINGS.end,
        lunchStart: lunchKeep ? parsed.lunchStart : '',
        lunchEnd: lunchKeep ? parsed.lunchEnd : '',
      }
    }

    // 内联文案表（zh / en）。locales 文件是它的镜像，自检核对两处键集一致。
    const MESSAGES = {
      zh: {
        meta: {
          title: '工资计算器',
          description:
            '挂在界面右下的工资看板：填月薪、上下班与午休时间，实时结算今天已经赚了多少钱（午休不计薪）。',
          detail: 'docs/DETAIL.md',
        },
        app: {
          title: '工资计算器',
          subtitle: '实时结算 · 只算今天 · 午休不计薪',
          earnedLabel: '今日已赚',
          hourlyLabel: '时薪',
          dailyLabel: '日薪',
          progressLabel: '今日进度',
          dragHint: '按住顶部可拖动',
        },
        line: {
          summary: '时薪 {hourly} · 今日进度 {progress}%',
        },
        status: {
          before: '还没上班',
          beforeEta: '还没上班 · 还有 {eta}开工',
          working: '正在赚',
          after: '今天收工了',
          afterEta: '今天收工了 · {eta}后开工',
        },
        eta: {
          minutes: '{n} 分钟',
          hourOnly: '{n} 小时',
          hours: '{n} 小时 {m} 分',
        },
        setup: {
          title: '填一下你的工资参数',
          monthlyLabel: '月薪',
          daysLabel: '每月工作天数',
          startLabel: '上班时间',
          endLabel: '下班时间',
          lunchLabel: '午餐休息（不计薪）',
          lunchStartLabel: '午休开始',
          lunchEndLabel: '午休结束',
        },
        unit: {
          yuan: '元',
          day: '天',
          percent: '%',
        },
        button: {
          start: '开始看板',
          save: '保存',
          cancel: '取消',
          settings: '设置',
          close: '关闭',
          undock: '展开工资计算器',
          lang: '语言',
        },
        toast: {},
        error: {
          invalidNumber: '请输入大于 0 的数字',
          invalidTime: '时间格式不对，应形如 09:00',
          invalidLunch: '午休时间不对：结束要晚于开始',
        },
      },
      en: {
        meta: {
          title: 'Wage Calculator',
          description:
            "A wage board pinned to the bottom-right of the UI: set monthly salary, work days, start/end times and lunch break to see today's earnings settle in real time (lunch unpaid).",
          detail: 'docs/DETAIL.en.md',
        },
        app: {
          title: 'Wage Calculator',
          subtitle: 'Settles in real time · today only · lunch unpaid',
          earnedLabel: 'Earned today',
          hourlyLabel: 'Hourly',
          dailyLabel: 'Daily',
          progressLabel: "Today's progress",
          dragHint: 'Drag the top edge to move',
        },
        line: {
          summary: '¥{hourly}/h · {progress}% of today',
        },
        status: {
          before: 'Not started yet',
          beforeEta: 'Not started · starts in {eta}',
          working: 'Earning now',
          after: 'Done for today',
          afterEta: 'Done for today · next shift in {eta}',
        },
        eta: {
          minutes: '{n} min',
          hourOnly: '{n} h',
          hours: '{n} h {m} min',
        },
        setup: {
          title: 'Set up your pay',
          monthlyLabel: 'Monthly salary',
          daysLabel: 'Working days per month',
          startLabel: 'Start time',
          endLabel: 'End time',
          lunchLabel: 'Lunch break (unpaid)',
          lunchStartLabel: 'Lunch starts',
          lunchEndLabel: 'Lunch ends',
        },
        unit: {
          yuan: 'CNY',
          day: 'd',
          percent: '%',
        },
        button: {
          start: 'Start board',
          save: 'Save',
          cancel: 'Cancel',
          settings: 'Settings',
          close: 'Close',
          undock: 'Show wage calculator',
          lang: 'Language',
        },
        toast: {},
        error: {
          invalidNumber: 'Enter a number greater than 0',
          invalidTime: 'Time must look like 09:00',
          invalidLunch: 'Lunch end must be after lunch start',
        },
      },
    }

    // SF-PURE-END
    // ==========================================================================
    // 2. 读盘 / 写盘
    // ==========================================================================

    /**
     * 跨重载 / 跨标签卡持久化：分层存储。
     *
     * 层级（越靠前越优先保存/读取）：
     *   1. window.localStorage —— 跨全页面刷新/重启都能存活（最佳）；
     *   2. window.__wcMem —— 挂在同一个 window 上的镜像，SPA 内部切标签/重挂载时，
     *      即使 localStorage 在沙箱 iframe 里被拒绝/隔离，也能保住设置不丢。
     *
     * 写：两级都写；读：先 localStorage，没有则回退到 window 镜像。
     * 这样无论 DSH 客户端是“整页不收 JS”（localStorage 生效）还是“跑在隔离 iframe”
     * （localStorage 可能失败、但同 window 镜像生效），设置都尽可能不丢。
     */
    function wcMem() {
      try {
        if (typeof window === 'undefined' || !window) return null
        if (!window.__wcMem) window.__wcMem = Object.create(null)
        return window.__wcMem
      } catch (err) {
        return null
      }
    }

    function readRaw(key) {
      const mem = wcMem()
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          const v = window.localStorage.getItem(key)
          if (v !== null && v !== undefined) return v
        }
      } catch (err) {
        /* localStorage 不可用则继续 */
      }
      if (mem) {
        const v = mem[key]
        return v === undefined ? null : v
      }
      return null
    }

    function writeRaw(key, value) {
      const str = JSON.stringify(value)
      const mem = wcMem()
      if (mem) {
        try {
          mem[key] = str
        } catch (err) {
          /* 忽略镜像写入失败 */
        }
      }
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(key, str)
        }
      } catch (err) {
        /* 忽略 localStorage 失败 —— 已靠 window 镜像兜底 */
      }
    }

    // ==========================================================================
    // 3. hook 区
    // ==========================================================================

    /** 结算时钟：节拍由调用方决定（默认 2 秒；收工后低频）。可见性暂停，回前台立即补一帧。 */
    function useTick(active, periodMs) {
      const period = Number.isFinite(periodMs) && periodMs >= 250 ? periodMs : SETTLE_MS
      const [now, setNow] = useState(() => Date.now())
      useEffect(() => {
        if (!active) return undefined
        let timer = null
        const stop = () => {
          if (timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
        const start = () => {
          stop()
          timer = setInterval(() => setNow(Date.now()), period)
        }
        const hidden = () => {
          try {
            return typeof document !== 'undefined' && document.visibilityState === 'hidden'
          } catch (err) {
            return false
          }
        }
        const onVisibility = () => {
          if (hidden()) stop()
          else {
            setNow(Date.now())
            start()
          }
        }
        setNow(Date.now())
        if (!hidden()) start()
        try {
          if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibility)
          }
        } catch (err) {
          /* 忽略 */
        }
        return () => {
          stop()
          try {
            if (typeof document !== 'undefined') {
              document.removeEventListener('visibilitychange', onVisibility)
            }
          } catch (err) {
            /* 忽略 */
          }
        }
      }, [active, period])
      return now
    }

    /** 一个键一份持久化。初值 lazy 读盘；null/undefined 不写盘。 */
    function usePersisted(key, initial, revive) {
      const [value, setValue] = useState(() => {
        try {
          const raw = readRaw(key)
          if (raw === null || raw === undefined) return initial
          const parsed = JSON.parse(raw)
          if (typeof revive === 'function') {
            const revived = revive(parsed)
            return revived === undefined ? initial : revived
          }
          return parsed === undefined ? initial : parsed
        } catch (err) {
          return initial
        }
      })
      useEffect(() => {
        if (value === null || value === undefined) return
        writeRaw(key, value)
      }, [key, value])
      return [value, setValue]
    }

    /** 语言：默认中文，存 localStorage，可选英文。 */
    function useLang() {
      const [lang, setLang] = usePersisted(LS_LANG, 'zh', (v) => (v === 'zh' || v === 'en' ? v : 'zh'))
      return useMemo(() => ({ lang, setLang }), [lang, setLang])
    }

    /** prefers-reduced-motion。 */
    function useReducedMotion() {
      const [reduced, setReduced] = useState(() => {
        try {
          if (typeof window === 'undefined' || !window.matchMedia) return false
          return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
        } catch (err) {
          return false
        }
      })
      useEffect(() => {
        let mql = null
        const onChange = () => {
          try {
            setReduced(mql ? mql.matches === true : false)
          } catch (err) {
            /* 忽略 */
          }
        }
        try {
          if (typeof window !== 'undefined' && window.matchMedia) {
            mql = window.matchMedia('(prefers-reduced-motion: reduce)')
            if (mql && typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
            else if (mql && typeof mql.addListener === 'function') mql.addListener(onChange)
          }
        } catch (err) {
          mql = null
        }
        return () => {
          try {
            if (!mql) return
            if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onChange)
            else if (typeof mql.removeListener === 'function') mql.removeListener(onChange)
          } catch (err) {
            /* 忽略 */
          }
        }
      }, [])
      return reduced
    }

    /** 槽位视图常量：board=右下浮层看板，hide=收进右上角状态栏胶囊。 */
    const VIEW_BOARD = 'board'
    const VIEW_HIDE = 'hide'

    /** 跨槽位共享设置：看板本体与顶栏胶囊看到同一份配置。 */
    let SHARED = null
    function getShared() {
      if (SHARED) return SHARED
      let settings = null
      let where = VIEW_BOARD
      try {
        const raw = readRaw(LS_SETTINGS)
        if (raw !== null && raw !== undefined) settings = reviveSettings(JSON.parse(raw))
      } catch (err) {
        settings = null
      }
      try {
        const href = readRaw(LS_HIDDEN)
        if (href !== null && href !== undefined) where = JSON.parse(href) === true ? VIEW_HIDE : VIEW_BOARD
      } catch (err) {
        where = VIEW_BOARD
      }
      SHARED = {
        store: makeStore({ settings, where, dockReady: false }),
        setSettings(next) {
          SHARED.store.set((prev) => ({ settings: next }))
          if (next !== null && next !== undefined) writeRaw(LS_SETTINGS, next)
        },
        setWhere(next) {
          const clean = next === VIEW_HIDE ? VIEW_HIDE : VIEW_BOARD
          SHARED.store.set((prev) => ({ where: prev.where === clean ? prev.where : clean }))
          writeRaw(LS_HIDDEN, next === VIEW_HIDE)
        },
        setDockReady(ready) {
          SHARED.store.set((prev) => ({ dockReady: ready === true }))
        },
      }
      return SHARED
    }

    /** 极简订阅容器。set 接受「新值」或「(prev)=>新值」两种形态。 */
    function makeStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get() {
          return value
        },
        set(next) {
          const computed = typeof next === 'function' ? next(value) : next
          if (computed === value) return
          value = computed
          listeners.forEach((fn) => {
            try {
              fn()
            } catch (err) {
              /* 忽略单个订阅者异常 */
            }
          })
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
      }
    }

    function useStore(store) {
      const [value, setValue] = useState(() => store.get())
      useEffect(() => store.subscribe(() => setValue(() => store.get())), [store])
      return value
    }

    // ==========================================================================
    // 4. 组件区
    // ==========================================================================

    /** 文案函数：按点号取键，占位符 {name} 替换。 */
    function makeT(lang) {
      const table = (MESSAGES && (MESSAGES[lang] || MESSAGES.zh)) || {}
      return function t(key, vars) {
        try {
          const path = String(key === null || key === undefined ? '' : key).split('.')
          let node = table
          for (let i = 0; i < path.length; i += 1) {
            if (node === null || typeof node !== 'object') {
              node = undefined
              break
            }
            node = node[path[i]]
          }
          let out = typeof node === 'string' ? node : String(key)
          if (vars && typeof vars === 'object') {
            out = out.replace(/\{(\w+)\}/g, (whole, name) => {
              const v = vars[name]
              return v === null || v === undefined ? whole : String(v)
            })
          }
          return out
        } catch (err) {
          return String(key)
        }
      }
    }

    /** 金额拆成逐字符数组，看板一格一字符。 */
    function splitDigits(str) {
      if (str === null || str === undefined) return []
      return Array.from(String(str))
    }

    /** 金额模板格：¥ 与小数点固定列，整数位右对齐补空槽，总长固定。 */
    function moneySlots(text) {
      const chars = splitDigits(text)
      const INT_SLOT_COUNT = 4
      const SLOT_COUNT = 8
      const dot = chars.lastIndexOf('.')
      const intCount = dot < 0 ? Math.max(chars.length - 1, 0) : Math.max(dot - 1, 0)
      if (intCount > INT_SLOT_COUNT) return slotify(text, SLOT_COUNT)
      const out = [chars[0] || '¥']
      for (let i = 0; i < INT_SLOT_COUNT - intCount; i += 1) out.push(' ')
      for (let i = 1; i < chars.length; i += 1) out.push(chars[i])
      while (out.length < SLOT_COUNT) out.push(' ')
      return out
    }

    /** 定宽补前导（超宽不裁）。 */
    function slotify(text, count) {
      const chars = splitDigits(text)
      if (chars.length >= count) return chars
      const pad = []
      for (let i = 0; i < count - chars.length; i += 1) pad.push('\u00a0')
      return pad.concat(chars)
    }

    /** 数字字符判定。 */
    function isDigit(ch) {
      return typeof ch === 'string' && ch.length === 1 && ch >= '0' && ch <= '9'
    }

    /** 只挑真正变了、且新值是数字的槽位。 */
    function changedSlots(prevSlots, nextSlots) {
      const out = []
      if (!Array.isArray(nextSlots)) return out
      const prev = Array.isArray(prevSlots) ? prevSlots : []
      for (let i = 0; i < nextSlots.length; i += 1) {
        if (prev[i] !== nextSlots[i] && isDigit(nextSlots[i])) out.push(i)
      }
      return out
    }

    /** 金额行：每个字符一格，变化位淡入标记。简化实现，不逐位翻牌，用颜色高亮变化位。 */
    function DigitText(props) {
      const chars = moneySlots(props.text)
      const prev = props.prevText ? moneySlots(props.prevText) : chars
      const changed = changedSlots(prev, chars)
      return h(
        'span',
        { className: 'wc-digits', 'aria-hidden': 'true' },
        chars.map((ch, i) =>
          h(
            'span',
            { key: i, className: 'wc-cell' + (ch === ' ' || ch === '\u00a0' ? ' is-blank' : '') + (changed.indexOf(i) >= 0 ? ' is-changed' : '') },
            ch === '\u00a0' ? '\u00a0' : ch,
          ),
        ),
      )
    }

    /** 倒计时人类形态。 */
    function fmtEta(ms, t) {
      const total = Math.max(0, Math.ceil(Number(ms) / 60000))
      if (!Number.isFinite(total)) return ''
      if (total < 60) return t('eta.minutes', { n: total })
      const hh = Math.floor(total / 60)
      const mm = total % 60
      return mm > 0 ? t('eta.hours', { n: hh, m: mm }) : t('eta.hourOnly', { n: hh })
    }

    function statusText(phase, view, now, t) {
      const isAfter = phase === 'after'
      const base = t(isAfter ? 'status.after' : 'status.before')
      const nextStart = Number(view && view.nextStart)
      const nowMs = Number(now)
      if (!Number.isFinite(nextStart) || nextStart <= 0 || !Number.isFinite(nowMs)) return base
      return t(isAfter ? 'status.afterEta' : 'status.beforeEta', { eta: fmtEta(nextStart - nowMs, t) })
    }

    const CSS = `
      .wc-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
      .wc-card {
        position: fixed;
        width: 280px;
        background: rgba(255,255,255,.96);
        color: #1f2328;
        border: 1px solid rgba(15,23,32,.10);
        border-radius: 14px;
        box-shadow: 0 12px 40px rgba(15,23,32,.14);
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        pointer-events: auto;
        user-select: none;
        overflow: hidden;
      }
      .wc-header { display: flex; align-items: center; }
      .wc-handle { display: flex; align-items: center; flex: 1; min-width: 0; padding: 10px 4px 6px 12px; cursor: move; }
      .wc-title { font-size: 13px; font-weight: 600; letter-spacing:.02em; flex: 1; }
      .wc-btns { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; padding: 6px 10px 2px 0; }
      .wc-iconbtn {
        background: transparent; border: none; color: #7c8494; cursor: pointer;
        font-size: 15px; line-height: 1; padding: 4px 6px; border-radius: 6px;
      }
      .wc-iconbtn:hover { background: rgba(15,23,32,.06); color: #1f2328; }
      .wc-body { padding: 2px 14px 14px; }
      .wc-caption { font-size: 11px; color: #707787; margin-bottom: 6px; }
      .wc-digits {
        display: flex; justify-content: flex-start; gap: 2px;
        font-variant-numeric: tabular-nums; font-size: 34px; font-weight: 700;
        letter-spacing: -1px; line-height: 1;
      }
      .wc-cell { min-width: .72em; text-align: center; }
      .wc-cell.is-blank { opacity: .18; }
      .wc-cell.is-changed { color: #1a9e5c; transition: color .3s; }
      .wc-line { font-size: 12px; color: #4c5560; margin-top: 8px; display: flex; align-items: center; gap: 6px; }
      .wc-prog { height: 6px; margin-top: 10px; border-radius: 3px; background: rgba(15,23,32,.10); overflow: hidden; }
      .wc-prog-fill { height: 100%; border-radius: 3px; background: #1a9e5c; transition: width .3s ease; }
      @media (prefers-reduced-motion: reduce) { .wc-prog-fill { transition: none; } }
      .wc-state { font-size: 12px; color: #b98b12; margin-top: 4px; }
      .wc-state.is-after { color: #1a9e5c; }
      .wc-setup { padding: 4px 14px 14px; }
      .wc-field { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .wc-field label { font-size: 12px; color: #4c5560; width: 108px; text-align: right; flex-shrink: 0; }
      .wc-input {
        flex: 1; min-width: 0; background: rgba(15,23,32,.04); border: 1px solid rgba(15,23,32,.16);
        color: #1f2328; border-radius: 6px; padding: 5px 8px; font-size: 13px; outline: none;
      }
      .wc-input:focus { border-color: #1a9e5c; }
      .wc-lunch { font-size: 11px; color: #707787; margin: 10px 0 6px; text-align: right; }
      .wc-note { font-size: 12px; color: #d64545; margin-top: 6px; }
      .wc-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
      .wc-btn {
        background: rgba(15,23,32,.05); color: #1f2328; border: 1px solid rgba(15,23,32,.16);
        border-radius: 7px; padding: 6px 12px; font-size: 13px; cursor: pointer;
      }
      .wc-btn:hover { background: rgba(15,23,32,.09); }
      .wc-btn--primary { background: #1a9e5c; border-color: transparent; font-weight: 600; }
      .wc-btn--primary:hover { background: #22b069; }
      .wc-btn--primary:disabled { background: rgba(26,158,92,.4); cursor: default; }
      .wc-chip {
        display: inline-flex; align-items: center; gap: 6px;
        background: rgba(15,23,32,.06); color: inherit;
        border: 1px solid rgba(15,23,32,.14); border-radius: 999px;
        padding: 3px 9px; font-size: 12px; font-variant-numeric: tabular-nums; cursor: pointer;
        white-space: nowrap; transition: background .15s, border-color .15s;
      }
      .wc-chip:hover { background: rgba(15,23,32,.11); border-color: rgba(15,23,32,.22); }
      .wc-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: #a6acb8; }
      .wc-chip-dot.is-live { background: #1a9e5c; animation: wc-breathe 1s ease-in-out infinite; }
      @keyframes wc-breathe { 0%,100%{opacity:1} 50%{opacity:.4} }
      .wc-showchip {
        position: fixed; display: inline-flex; align-items: center; gap: 7px;
        padding: 7px 14px; background: rgba(255,255,255,.97); color: #1f2328;
        border: 1px solid rgba(15,23,32,.12); border-radius: 999px; cursor: pointer;
        font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums;
        pointer-events: auto; box-shadow: 0 8px 28px rgba(15,23,32,.14);
        transition: background .15s, border-color .15s, transform .15s;
      }
      .wc-showchip:hover { background: rgba(248,249,250,.99); border-color: rgba(15,23,32,.22); }
      .wc-showchip .wc-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: #a6acb8; }
      .wc-showchip .wc-chip-dot.is-live { background: #1a9e5c; animation: wc-breathe 1s ease-in-out infinite; }
      .wc-showchip .wc-clickable { pointer-events: auto; }
      @media (prefers-reduced-motion: reduce) { .wc-cell.is-changed { transition: none; } }
    `

    /** 设置卡：月薪 / 天数 / 上下班 / 午休。 */
    function SetupCard(props) {
      const t = props.t
      const initial = props.initial || DEFAULT_SETTINGS
      const [monthly, setMonthly] = useState(() => String(initial.monthly))
      const [days, setDays] = useState(() => String(initial.days))
      const [start, setStart] = useState(() => (parseHHMM(initial.start) === null ? DEFAULT_SETTINGS.start : initial.start))
      const [end, setEnd] = useState(() => (parseHHMM(initial.end) === null ? DEFAULT_SETTINGS.end : initial.end))
      const [lunchStart, setLunchStart] = useState(() =>
        parseHHMM(initial.lunchStart) === null ? DEFAULT_SETTINGS.lunchStart : initial.lunchStart,
      )
      const [lunchEnd, setLunchEnd] = useState(() =>
        parseHHMM(initial.lunchEnd) === null ? DEFAULT_SETTINGS.lunchEnd : initial.lunchEnd,
      )
      const [touched, setTouched] = useState(false)

      const check = validateSettings({ monthly, days, start, end, lunchStart, lunchEnd })

      const submit = () => {
        setTouched(true)
        if (!check.ok) return
        try {
          if (typeof props.onSubmit === 'function') props.onSubmit(check.value)
        } catch (err) {
          /* 忽略 */
        }
      }
      const onKeyDown = (e) => {
        if (e && e.key === 'Enter') {
          e.preventDefault()
          submit()
        }
      }
      const field = (id, label, value, setValue, extra) =>
        h(
          'div',
          { className: 'wc-field' },
          h('label', { htmlFor: id }, label),
          h(
            'input',
            Object.assign(
              {
                id,
                className: 'wc-input',
                type: 'text',
                inputMode: extra && extra.time ? 'none' : 'decimal',
                autoComplete: 'off',
                spellCheck: false,
                value,
                onChange: (e) => setValue(e.target.value),
                onKeyDown,
              },
              extra || {},
            ),
          ),
        )

      return h(
        'div',
        { className: 'wc-setup' },
        h(
          'div',
          { className: 'wc-handle', title: t('app.dragHint'), ...(props.dragHandlers || {}) },
          h('span', { className: 'wc-title' }, t('setup.title')),
        ),
        h('div', { className: 'wc-caption' }, t('app.subtitle')),
        field('wc-monthly', t('setup.monthlyLabel') + '(' + t('unit.yuan') + ')', monthly, setMonthly),
        field('wc-days', t('setup.daysLabel') + '(' + t('unit.day') + ')', days, setDays),
        field('wc-start', t('setup.startLabel'), start, setStart, { type: 'time' }),
        field('wc-end', t('setup.endLabel'), end, setEnd, { type: 'time' }),
        h('div', { className: 'wc-lunch' }, t('setup.lunchLabel')),
        field('wc-lunch-start', t('setup.lunchStartLabel'), lunchStart, setLunchStart, { type: 'time' }),
        field('wc-lunch-end', t('setup.lunchEndLabel'), lunchEnd, setLunchEnd, { type: 'time' }),
        check.ok
          ? h(
              'div',
              { className: 'wc-line' },
              t('app.hourlyLabel') +
                ' ' +
                fmtMoney(calc(check.value, Date.now()).hourly) +
                ' · ' +
                t('app.dailyLabel') +
                ' ' +
                fmtMoney(calc(check.value, Date.now()).dailyWage),
            )
          : null,
        touched && !check.ok ? h('div', { className: 'wc-note' }, '⚠ ' + t(check.reason)) : null,
        h(
          'div',
          { className: 'wc-actions' },
          props.onCancel
            ? h('button', { type: 'button', className: 'wc-btn', onClick: props.onCancel }, t('button.cancel'))
            : null,
          h(
            'button',
            { type: 'button', className: 'wc-btn wc-btn--primary', disabled: !check.ok, onClick: submit },
            props.onCancel ? t('button.save') : t('button.start'),
          ),
        ),
      )
    }

    /** 运行看板：大号金额 + 时薪/进度 + 状态 + 设置/关闭键。 */
    function RunningCard(props) {
      const t = props.t
      const view = props.view || { earned: 0, hourly: 0, progress: 0, phase: 'before' }
      const pct = Math.round(clampNum(view.progress, 0, 1) * 100)
      const phase = view.phase === 'after' ? 'after' : view.phase === 'working' ? 'working' : 'before'
      // 图标按钮：只用 onClick 单击触发，避免 pointerdown+click 双重触发把状态翻两次。
      // 按钮放在 .wc-btns 组里，和可拖动的 .wc-handle 是兄弟（不嵌套），点击完全不碰拖动手势。
      const g = (label, onClick) =>
        h(
          'button',
          {
            type: 'button',
            className: 'wc-iconbtn',
            title: label,
            'aria-label': label,
            onClick: (e) => {
              try {
                e.stopPropagation()
              } catch (err) {
                /* 忽略 */
              }
              if (typeof onClick === 'function') onClick()
            },
          },
          label === t('button.settings') ? '\u2699' : '\u00d7',
        )

      return h(
        'div',
        { className: 'wc-body' },
        h(
          'div',
          { className: 'wc-header' },
          h('div', { className: 'wc-handle', title: t('app.dragHint'), ...(props.dragHandlers || {}) }, h('span', { className: 'wc-title' }, t('app.title'))),
          h(
            'span',
            { className: 'wc-btns' },
            g(t('button.settings'), props.onSettings),
            g(t('button.close'), props.onClose),
          ),
        ),
        h('div', { className: 'wc-caption' }, t('app.earnedLabel')),
        h(DigitText, { text: props.money, prevText: props.prevText }),
        h(
          'div',
          { className: 'wc-line', 'aria-label': t('app.progressLabel') + ' ' + pct + t('unit.percent') },
          t('line.summary', { hourly: fmtMoney(view.hourly), progress: pct }),
        ),
        h(
          'div',
          { className: 'wc-prog', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('div', { className: 'wc-prog-fill', style: { width: pct + '%' } }),
        ),
        phase === 'before' || phase === 'after'
          ? h(
              'div',
              { className: 'wc-state' + (phase === 'after' ? ' is-after' : '') },
              statusText(phase, view, props.now, t),
            )
          : null,
      )
    }

    /** 顶栏胶囊（dock 态）。 */
    function DockChip(props) {
      const t = props.t
      const view = props.view || { earned: 0, phase: 'before' }
      const money = fmtMoney(view.earned)
      const live = view.phase === 'working'
      return h(
        'button',
        { type: 'button', className: 'wc-chip', title: t('button.undock'), onClick: props.onUndock },
        h('span', { className: 'wc-chip-dot' + (live ? ' is-live' : '') }),
        h('span', {}, money),
      )
    }

    /**
     * 右上角状态栏宿主（`conversation.session.header.utilities`，session 作用域 list 槽位）。
     *
     * 只在「收起」态渲染一小颗胶囊进右上状态栏：实时工资 + 呼吸灯。
     * 点它把看板调回浮层。自己在收起态下节拍结算（因为右下看板此刻不渲染）。
     */
    function DockSlotHost() {
      const shared = getShared()
      const snap = useStore(shared.store)
      const { lang } = useLang()
      const t = useMemo(() => makeT(lang), [lang])

      const hasSettings = snap.settings !== null && snap.settings !== undefined
      const activeSettings = hasSettings ? snap.settings : DEFAULT_SETTINGS
      const active = hasSettings && snap.where === VIEW_HIDE

      const probe = calc(activeSettings, Date.now())
      const period = probe.phase === 'after' ? IDLE_MS : SETTLE_MS
      const now = useTick(active, period)
      const view = useMemo(() => calc(activeSettings, now), [activeSettings, now])

      const onUndock = useCallback(() => shared.setWhere(VIEW_BOARD), [shared])

      // 登记「顶栏有人渲染」，右下看板据此决定是否在收起态自己兜一块。
      useEffect(() => {
        shared.setDockReady(true)
        return () => shared.setDockReady(false)
      }, [shared])

      if (!active) return null
      return h(
        'span',
        { className: 'wc-chipwrap' },
        h('style', { key: 'wc-dock-css' }, CSS),
        h(DockChip, { view, onUndock, t }),
      )
    }

    /**
     * 拖动 hook：pointer 事件 + clamp 到视口内。拖动只在移动中更新 draft，抬手才落盘。
     */
    function useDrag(params) {
      const setPos = params && typeof params.setPos === 'function' ? params.setPos : null
      const [draft, setDraft] = useState(null)
      const dragRef = useRef(null)
      const movedRef = useRef(false)
      const lastRef = useRef(null)
      const sizeRef = useRef((params && params.size) || { w: CARD_W, h: H_RUNNING })
      const posRef = useRef((params && params.pos) || null)
      sizeRef.current = (params && params.size) || sizeRef.current
      posRef.current = (params && params.pos) || null

      function clampPos(x, y, w, h) {
        let vw = 1280
        let vh = 800
        try {
          if (typeof window !== 'undefined') {
            if (Number.isFinite(window.innerWidth)) vw = window.innerWidth
            if (Number.isFinite(window.innerHeight)) vh = window.innerHeight
          }
        } catch (err) {
          /* 忽略 */
        }
        const cw = Number.isFinite(w) && w > 0 ? w : CARD_W
        const ch = Number.isFinite(h) && h > 0 ? h : H_RUNNING
        const maxX = Math.max(EDGE, vw - cw - EDGE)
        const maxY = Math.max(EDGE, vh - ch - EDGE)
        return {
          x: Number.isFinite(x) ? Math.min(Math.max(x, EDGE), maxX) : maxX,
          y: Number.isFinite(y) ? Math.min(Math.max(y, EDGE), maxY) : maxY,
        }
      }

      const onPointerDown = useCallback((e) => {
        try {
          if (!e || typeof e.clientX !== 'number') return
          if (typeof e.button === 'number' && e.button > 0) return
          const host = e.currentTarget && typeof e.currentTarget.closest === 'function' ? e.currentTarget.closest('.wc-card') : null
          const rect = host && typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : null
          const originX = rect && Number.isFinite(rect.left) ? rect.left : posRef.current && Number.isFinite(posRef.current.x) ? posRef.current.x : EDGE
          const originY = rect && Number.isFinite(rect.top) ? rect.top : posRef.current && Number.isFinite(posRef.current.y) ? posRef.current.y : EDGE
          dragRef.current = { startX: e.clientX, startY: e.clientY, originX, originY }
          movedRef.current = false
          lastRef.current = { x: originX, y: originY }
          setDraft({ x: originX, y: originY })
          if (e.currentTarget && typeof e.currentTarget.setPointerCapture === 'function' && e.pointerId != null) {
            e.currentTarget.setPointerCapture(e.pointerId)
          }
        } catch (err) {
          /* 忽略 */
        }
      }, [])

      const onPointerMove = useCallback((e) => {
        const d = dragRef.current
        if (!d || !e) return
        try {
          const dx = e.clientX - d.startX
          const dy = e.clientY - d.startY
          if (!movedRef.current && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) movedRef.current = true
          if (!movedRef.current) return
          const size = sizeRef.current || { w: CARD_W, h: H_RUNNING }
          const next = clampPos(d.originX + dx, d.originY + dy, size.w, size.h)
          lastRef.current = next
          setDraft(next)
        } catch (err) {
          /* 忽略 */
        }
      }, [])

      const finish = useCallback(
        (commit) => {
          const d = dragRef.current
          if (!d) return
          dragRef.current = null
          const wasMoved = movedRef.current
          const last = lastRef.current
          setDraft(null)
          if (commit && wasMoved && last && setPos) {
            try {
              setPos({ x: last.x, y: last.y })
            } catch (err) {
              /* 忽略 */
            }
          }
        },
        [setPos],
      )

      const onPointerUp = useCallback(
        (e) => {
          try {
            if (e && e.currentTarget && typeof e.currentTarget.releasePointerCapture === 'function' && e.pointerId != null) {
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          } catch (err) {
            /* 忽略 */
          }
          finish(true)
        },
        [finish],
      )
      const onPointerCancel = useCallback(
        (e) => {
          try {
            if (e && e.currentTarget && typeof e.currentTarget.releasePointerCapture === 'function' && e.pointerId != null) {
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          } catch (err) {
            /* 忽略 */
          }
          finish(true)
        },
        [finish],
      )

      return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, draft }
    }

    /** 根组件。 */
    function SalaryCard(props) {
      const reduced = useReducedMotion()
      const shared = getShared()
      const sharedSnap = useStore(shared.store)
      const settings = sharedSnap.settings
      const setSettings = shared.setSettings

      const { lang, setLang } = useLang()
      const t = useMemo(() => makeT(lang), [lang])

      const [pos, setPos] = usePersisted(LS_POS, null, (v) =>
        v && typeof v === 'object' && !Array.isArray(v) && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) ? { x: Number(v.x), y: Number(v.y) } : null,
      )
      const [editing, setEditing] = useState(false)
      // 收起态改为组件本地 state（不经过跨槽位 store）：收起 = 本组件记忆，展开 = 点胶囊。
      // 彻底绕开 store 订阅/重渲染对「收起-展开」的竞争，避免「点 ✕ 闪一下弹回」。
      const [hidden, setHidden] = useState(() => {
        try {
          const h = readRaw(LS_HIDDEN)
          return h !== null && h !== undefined ? JSON.parse(h) === true : false
        } catch (err) {
          return false
        }
      })
      // 记录「刚收起」的时刻，防止残留点击立刻把胶囊点开。
      const justClosedAt = useRef(-1)

      const hasSettings = settings !== null && settings !== undefined
      const activeSettings = hasSettings ? settings : DEFAULT_SETTINGS

      const probe = calc(activeSettings, Date.now())
      const period = probe.phase === 'after' ? IDLE_MS : SETTLE_MS
      const now = useTick(hasSettings, period)
      const view = useMemo(() => calc(activeSettings, now), [activeSettings, now])

      const moneyText = fmtMoney(view.earned)
      const prevMoneyRef = useRef(moneyText)
      const [prevMoney, setPrevMoney] = useState(moneyText)
      useEffect(() => {
        if (prevMoneyRef.current === moneyText) return
        const from = prevMoneyRef.current
        prevMoneyRef.current = moneyText
        setPrevMoney(from)
        const timer = setTimeout(() => setPrevMoney(moneyText), reduced ? 0 : 600)
        return () => clearTimeout(timer)
      }, [moneyText, reduced])

      const cardRef = useRef(null)
      const [measuredH, setMeasuredH] = useState(0)
      useEffect(() => {
        let ro = null
        try {
          const el = cardRef.current
          if (!el || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return undefined
          const read = () => {
            const hh = el.offsetHeight
            if (Number.isFinite(hh) && hh > 0) setMeasuredH(hh)
          }
          read()
          ro = new window.ResizeObserver(read)
          ro.observe(el)
        } catch (err) {
          ro = null
        }
        return () => {
          if (ro) {
            try {
              ro.disconnect()
            } catch (err) {
              /* 忽略 */
            }
          }
        }
      }, [])
      const cardH = measuredH > 0 ? measuredH : !hasSettings || editing ? H_SETUP : H_RUNNING
      const drag = useDrag({ pos, setPos, size: { w: CARD_W, h: cardH } })

      const defaultPos = useMemo(() => {
        let vw = 1280
        let vh = 800
        try {
          if (typeof window !== 'undefined') {
            vw = Number.isFinite(window.innerWidth) ? window.innerWidth : vw
            vh = Number.isFinite(window.innerHeight) ? window.innerHeight : vh
          }
        } catch (err) {
          /* 忽略 */
        }
        return { x: vw - CARD_W - DEFAULT_INSET.right, y: vh - cardH - DEFAULT_INSET.bottom }
      }, [cardH])

      const base = drag.draft || pos || defaultPos
      // clamp
      let vw = 1280
      let vh = 800
      try {
        if (typeof window !== 'undefined') {
          vw = Number.isFinite(window.innerWidth) ? window.innerWidth : vw
          vh = Number.isFinite(window.innerHeight) ? window.innerHeight : vh
        }
      } catch (err) {
        /* 忽略 */
      }
      const maxX = Math.max(EDGE, vw - CARD_W - EDGE)
      const maxY = Math.max(EDGE, vh - cardH - EDGE)
      const safe = { x: Math.min(Math.max(base.x, EDGE), maxX), y: Math.min(Math.max(base.y, EDGE), maxY) }

      const onSubmit = useCallback(
        (next) => {
          setSettings(next)
          setEditing(false)
        },
        [setSettings],
      )
      const onCancel = useCallback(() => setEditing(false), [])
      const onSettings = useCallback(() => setEditing(true), [])
      const onClose = useCallback(() => {
        // 收起：记录时间戳 + 置本地 hidden。不再写 store.where，避免与别的槽位竞争。
        try {
          if (typeof Date.now === 'function') justClosedAt.current = Date.now()
        } catch (err) {
          /* 忽略 */
        }
        setHidden(true)
        writeRaw(LS_HIDDEN, true)
      }, [])
      const onShow = useCallback(() => {
        // 若距离收起还不到 400ms，说明是刚才那次点击的残留/连带触发，忽略这次展开。
        try {
          if (typeof Date.now === 'function' && Date.now() - justClosedAt.current < 400) return
        } catch (err) {
          /* 忽略 */
        }
        setHidden(false)
        writeRaw(LS_HIDDEN, false)
      }, [])

      // 挂载时兜底校准：若共享 store 里没有设置，但 localStorage 里有一份真实保存的，
      // 立即把 store 校准为这份（避免因模块重载/槽位重挂载而把已有设置当成“没有”）。
      useEffect(() => {
        if (sharedSnap.settings !== null && sharedSnap.settings !== undefined) return
        try {
          const raw = readRaw(LS_SETTINGS)
          if (raw === null || raw === undefined) return
          const revived = reviveSettings(JSON.parse(raw))
          if (revived !== null) shared.setSettings(revived)
        } catch (err) {
          /* 忽略 */
        }
      }, [shared, sharedSnap.settings])

      // 关闭态：看板本体隐藏，只留一颗右下角小胶囊（带实时金额），点它重新展开。
      // 胶囊不是「没关掉」，而是收起后的精简入口。
      if (hidden) {
        let cw = 1280
        try {
          if (typeof window !== 'undefined' && Number.isFinite(window.innerWidth)) cw = window.innerWidth
        } catch (err) {
          /* 忽略 */
        }
        const live = view.phase === 'working'
        return h(
          'div',
          { className: 'wc-layer' },
          h('style', { key: 'wc-css' }, CSS),
          h(
            'div',
            {
              className: 'wc-showchip',
              onClick: onShow,
              title: t('button.undock'),
              role: 'button',
              style: { left: Math.max(EDGE, cw - 132 - EDGE) + 'px', bottom: (DEFAULT_INSET.bottom - 30) + 'px' },
            },
            h('span', { className: 'wc-chip-dot' + (live ? ' is-live' : '') }),
            h('span', { className: 'wc-clickable' }, moneyText),
          ),
        )
      }

      const body =
        !hasSettings || editing
          ? h(SetupCard, { initial: hasSettings ? settings : DEFAULT_SETTINGS, onSubmit, onCancel: hasSettings ? onCancel : null, dragHandlers: drag, lang, setLang, t })
          : h(RunningCard, { view, now, money: moneyText, prevText: prevMoney, reduced, dragHandlers: drag, onSettings, onClose, t })

      return h(
        'div',
        { className: 'wc-layer' },
        h('style', { key: 'wc-css' }, CSS),
        h(
          'div',
          { className: 'wc-card', ref: cardRef, style: { left: safe.x + 'px', top: safe.y + 'px' } },
          body,
        ),
      )
    }

    // ==========================================================================
    // 5. 注册区
    // ==========================================================================

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') return
      // 右下浮层看板：settings 表单 + 实时工资展示。收起态由右下小圆点重新打开。
      // （宿主没有全局的右上角状态栏槽位，顶栏只在会话页渲染，故只用一个全局 overlay。）
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          { name: 'shell.overlay', id: 'wage-calculator', order: 12, label: '工资计算器' },
          () => h(SalaryCard, { runtime: ctx }),
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})