export type RailAction = 'new' | 'import' | 'collections' | 'env' | 'io' | 'history' | 'share'

interface Props {
  onAction: (action: RailAction) => void
  /** 徽章文案由调用点算：这一层不知道集合有多大，只知道该不该显示。 */
  badges?: Partial<Record<RailAction, string>>
  disabled?: Partial<Record<RailAction, boolean>>
}

/**
 * 左侧操作栏。
 *
 * 用两字中文而不是图标：一是这个工具的动词本来就是中文（集合 / 环境 / 导入），
 * 图标要么画错要么画成通用几何体，反而比两个字难认；二是 56px 宽放两个 12px 的字刚好，
 * 而 SVG 图标加 tooltip 的方案在"悬停才知道是什么"这件事上更慢。
 * 代价写明白：不像 Postman 那样一眼是"专业工具"。换到的是不用猜。
 */
const ITEMS: { value: RailAction; label: string; title: string }[] = [
  { value: 'new', label: '新建', title: '清成一条空请求（当前这条已经自动存在草稿里）' },
  { value: 'import', label: '导入', title: '粘贴一段 curl 命令导入（弹窗）' },
  { value: 'collections', label: '集合', title: '打开资料库 · 集合（存这条、取那条）' },
  { value: 'env', label: '环境', title: '打开资料库 · 环境 · 变量（{{变量}} 从这儿来）' },
  { value: 'io', label: '导出', title: '打开资料库 · 导入 / 导出（整库 JSON、分享链接）' },
  { value: 'history', label: '历史', title: '跳到结果栏的历史（只存这台机器）' },
  { value: 'share', label: '分享', title: '生成链接 / 二维码，对方打开就导入（默认脱敏）' }
]

export function Rail({ onAction, badges = {}, disabled = {} }: Props) {
  return (
    <nav className="rail" aria-label="请求操作栏">
      {ITEMS.map((item) => {
        const badge = badges[item.value]
        return (
          <button
            key={item.value}
            type="button"
            className="rail-btn"
            title={item.title}
            aria-label={badge ? `${item.label}（${badge}）` : item.label}
            disabled={disabled[item.value] === true}
            onClick={() => onAction(item.value)}
          >
            <span className="rail-label">{item.label}</span>
            {badge !== undefined && <span className="rail-badge">{badge}</span>}
          </button>
        )
      })}
    </nav>
  )
}

export default Rail
