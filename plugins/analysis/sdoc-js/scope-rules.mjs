// scope-rules.mjs — 知识块 scope 规则预判表
// 当 LLM 不可用或未返回 scope 时兜底分类；LLM 裁决仅用于规则不确定的场景。

const _USER_DIR_RE = /(\/home\/|\/Users\/|C:\\Users\\|\\Users\\)/i;

/**
 * 依据场景与证据 facts 预判知识块 scope。
 * @param {string} scenario S1-S20 编号
 * @param {object} facts   extractFacts 输出（runtimes / commands_seen 等）
 * @returns {'personal'|'organization'}
 */
export function inferScope(scenario, facts = {}) {
  switch (scenario) {
    case 'S1': // 运行时版本探测：路径含用户目录 → personal；否则归组织通用
      return _mentionsUserDir(facts) ? 'personal' : 'organization';
    case 'S3': // 构建/测试命令 → 组织通用
    case 'S4': // git 规范 → 组织通用
      return 'organization';
    case 'S8': // 命令未找到：本机 PATH 差异 → personal
    case 'S9': // 依赖/权限/网络：本机环境 → personal
    case 'S17': // 缺失资源/工具：本机安装 → personal
    case 'S18': // skill 配置：个人配置 → personal
      return 'personal';
    default:
      // S2/S5/S6/S7/S10-S16/S19/S20 及未知场景：组织共享价值高 → organization
      return 'organization';
  }
}

function _mentionsUserDir(facts) {
  const runtimes = Object.keys(facts?.runtimes || {}).join(' ');
  const commands = (facts?.commands_seen || []).join(' ');
  return _USER_DIR_RE.test(runtimes) || _USER_DIR_RE.test(commands);
}
