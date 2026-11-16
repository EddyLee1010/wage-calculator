/**
 * 「工资计算器」Host 半边入口。
 *
 * 本插件是纯前端插件：计算、持久化、渲染全部在浏览器侧完成，不需要 Host 进程
 * 提供任何本地服务或弹窗。因此这里只声明它在 Cordis 装配层里的存在与依赖，
 * 不做任何副作用（不开 Server、不注册 HTTP 路由，也就没有需要收尾的清理项）。
 */

/**
 * Cordis context 装配入口。这里什么也不做，只为让包在 Cordis 里可解析、可挂载。
 * client 侧的 UI 由 dsh.client.platform=web 注入，走 browser 槽位加载。
 *
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  // 纯前端插件：无 Host 资源需要申请。apply 体保持为空即可。
  // （保留 ctx 参数而不使用，避免 linter 报未使用。）
  void ctx
}

/** 本插件不依赖 Host 侧任何具体服务（不需要 inject）。 */
export const inject = []