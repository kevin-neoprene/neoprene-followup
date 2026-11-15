// 部署配置示例：复制为 config.js 后填入真实值。
// config.js 不要提交到 GitHub（已在 README 的 .gitignore 清单里）。
// 这里只有占位符，没有任何真实密钥。
window.FOLLOWUP_CONFIG = {
  // 复用 Supabase 项目 neoprene-order-assistant（免费版已满 2 个，不新建）
  SUPABASE_URL: 'https://gplkvdodbfzknyafdttb.supabase.co',
  // Supabase 项目设置 -> API -> anon public key（公开 key，只配合 RLS 读/写跟进表）
  SUPABASE_ANON_KEY: 'PASTE_ANON_KEY_HERE'
};
