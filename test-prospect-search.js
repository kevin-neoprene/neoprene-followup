// 搜客池 Phase 2 站内搜索冒烟测试（本地跑，不碰真实数据库，不调 DeepSeek；
//   只测 app.js 里 Phase 2 的纯函数 + 复用的导入流程，共 25 项）。
// 覆盖：(a) 搜索导入元数据；(b) 三铁只拦主营；(c) 搜索行规范化；
//   (d) 最多 10 家；(e) 建议关键词与上限常量；(f) 导入流程复用（入池/淘汰/去重/覆盖记忆）。
// 用法：node test-prospect-search.js

var P = require('./app.js');

var passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// 服务端行（与 api/prospect-search.js 的 buildCompanyRow 输出同构；
//   contact_email 与 email 两列都带，normalizeProspectRow 只认 email 那列）。
function srow(o) {
  return Object.assign({
    company: '', domain: '', website: '', country: '', size_text: '', size_min: null, size_max: null,
    evidence_url: '', evidence_excerpt: '', evidence_level: '', product_category: '', industry: '',
    oem_text: '', activity_text: '', contact_name: '', contact_role: '',
    contact_email: '', email: '', phone: '', whatsapp: ''
  }, o);
}

// (a) 搜索导入元数据：与 Excel 导入同一结构（国家/关键词组/来源）
var m1 = P.prospectSearchImportMeta('定制潜水服', '西班牙');
check('(a) 元数据：国家/关键词组/来源', m1.keywordGroup === '定制潜水服' && m1.country === '西班牙' && m1.source === '站内搜索', JSON.stringify(m1));
var m2 = P.prospectSearchImportMeta('  定制潜水服  ', '  西班牙  ');
check('(a) 元数据去前后空格', m2.keywordGroup === '定制潜水服' && m2.country === '西班牙', JSON.stringify(m2));
var m3 = P.prospectSearchImportMeta();
check('(a) 元数据缺省为空串', m3.keywordGroup === '' && m3.country === '' && m3.source === '站内搜索', JSON.stringify(m3));
var m4 = P.prospectSearchImportMeta('潜水装备', '葡萄牙');
check('(a) 元数据透传其它国家/关键词', m4.keywordGroup === '潜水装备' && m4.country === '葡萄牙', JSON.stringify(m4));

// (b) 三铁只拦主营（2026-11-21 23:20 用户放宽）：主营判断只看公司名/产品类别/行业
var tri = srow({
  company: 'Triathlon Gear Co', domain: 'trishop.com', website: 'https://trishop.com', country: '西班牙',
  size_text: '20-50 人',
  evidence_url: 'https://trishop.com/neoprene', evidence_excerpt: 'Neoprene triathlon wetsuits for open water racing.',
  product_category: '潜水服',
  contact_name: 'Ann Lee', contact_role: 'Founder', contact_email: 'ann@trishop.com', email: 'ann@trishop.com'
});
check('(b) 三铁仍淘汰', P.checkProspectHardRules(tri).ok === false);
var kynay = srow({
  company: 'Kynay', domain: 'kynay.com', website: 'https://kynay.com', country: '西班牙',
  evidence_url: 'https://kynay.com/about-us/',
  evidence_excerpt: 'We started in 2005 as a company specialized in neoprene wetsuits. We manufacture our own brand of wetsuits for surfing, windsurfing, kite surfing, stand up paddle, triathlon, diving, spearfishing.',
  product_category: '定制潜水服', contact_email: 'kynay@kynay.com', email: 'kynay@kynay.com'
});
check('(b2b) 三铁只拦主营：证据摘录顺带提到三铁不拦', P.checkProspectHardRules(kynay).ok === true, JSON.stringify(P.checkProspectHardRules(kynay)));
var triMain = srow({
  company: 'Ironman Triathlon Store', domain: 'ironmantri.com', website: 'https://ironmantri.com', country: '美国',
  evidence_url: 'https://ironmantri.com/', evidence_excerpt: 'Neoprene wetsuits for triathlon racing.',
  product_category: '三铁潜水服', contact_email: 'info@ironmantri.com', email: 'info@ironmantri.com'
});
var hardTriMain = P.checkProspectHardRules(triMain);
check('(b) 主营三铁公司仍淘汰', hardTriMain.ok === false && /主营三铁/.test(hardTriMain.reason), JSON.stringify(hardTriMain));

// (c) 搜索行规范化：只取服务端已给的字段（不编造），来源统一标为站内搜索
var kynayRow = srow({
  company: 'Kynay', domain: 'kynay.com', website: 'https://kynay.com', country: '西班牙',
  evidence_url: 'https://kynay.com/about-us/',
  evidence_excerpt: 'We started in 2005 as a company specialized in neoprene wetsuits.',
  product_category: '定制潜水服', contact_email: 'kynay@kynay.com', email: 'kynay@kynay.com'
});
var normed = P.normalizeProspectSearchCompanies([kynayRow]);
check('(c) 公司/域名/网址/国家保留', normed.length === 1 && normed[0].company === 'Kynay' && normed[0].domain === 'kynay.com' && normed[0].website === 'https://kynay.com' && normed[0].country === '西班牙', JSON.stringify(normed[0]));
check('(c) 证据链接/摘录保留', normed[0].evidence_url === 'https://kynay.com/about-us/' && normed[0].evidence_excerpt.indexOf('neoprene wetsuits') !== -1, JSON.stringify(normed[0]));
check('(c) 邮箱保留', normed[0].contact_email === 'kynay@kynay.com', JSON.stringify(normed[0]));
check('(c) 来源标为站内搜索', normed[0].source === '站内搜索', JSON.stringify(normed[0]));
check('(c) 非数组返回空数组', P.normalizeProspectSearchCompanies(null).length === 0 && P.normalizeProspectSearchCompanies('x').length === 0);
check('(c) 空数组返回空数组', P.normalizeProspectSearchCompanies([]).length === 0);
var bare = P.normalizeProspectSearchCompanies([{ company: 'Bare Co', domain: 'bare.com', website: 'https://bare.com' }]);
check('(c) 缺字段不编造：默认空串', bare.length === 1 && (bare[0].country || '') === '' && (bare[0].contact_email || '') === '' && (bare[0].evidence_excerpt || '') === '', JSON.stringify(bare[0]));

// (d) 最多取 PROSPECT_SEARCH_MAX_RESULTS 家
function many(n) {
  var arr = [];
  for (var i = 0; i < n; i++) arr.push(srow({ company: 'Co ' + i, domain: 'co' + i + '.com', website: 'https://co' + i + '.com', country: '西班牙' }));
  return arr;
}
check('(d) 12 家只取 10 家', P.normalizeProspectSearchCompanies(many(12)).length === 10);
check('(d) 不足 10 家全取', P.normalizeProspectSearchCompanies(many(3)).length === 3);

// (e) 上限与建议关键词常量
check('(e) 上限常量是 10', P.PROSPECT_SEARCH_MAX_RESULTS === 10);
check('(e) 建议关键词 4 个', Array.isArray(P.PROSPECT_SEARCH_SUGGESTIONS) && P.PROSPECT_SEARCH_SUGGESTIONS.length === 4);
check('(e) 建议关键词内容', ['定制潜水服', '氯丁橡胶潜水服', '潜水装备', '冲浪潜水服'].every(function (k) { return P.PROSPECT_SEARCH_SUGGESTIONS.indexOf(k) !== -1; }), JSON.stringify(P.PROSPECT_SEARCH_SUGGESTIONS));

// (f) 导入流程复用：搜索行直接喂 processProspectImport（入池/淘汰/去重/覆盖记忆）
var strong = srow({
  company: 'Costa Neoprene SL', domain: 'costaneoprene.es', website: 'https://costaneoprene.es', country: '西班牙',
  size_text: '20-50 人',
  evidence_url: 'https://costaneoprene.es/shop', evidence_excerpt: 'Neoprene wetsuits, custom wetsuits, OEM wetsuits, add to cart.',
  evidence_level: 'site_sale', product_category: '潜水服', oem_text: 'OEM, custom wetsuits, wholesale',
  contact_name: 'Carlos Ruiz', contact_role: 'CEO', contact_email: 'carlos@costaneoprene.es', email: 'carlos@costaneoprene.es', phone: '+34 600 123 456'
});
var triRow = srow({
  company: 'Triathlon Pro SL', domain: 'tripro.es', website: 'https://tripro.es', country: '西班牙',
  evidence_url: 'https://tripro.es/', evidence_excerpt: 'Neoprene triathlon wetsuits for racing.',
  product_category: '三铁潜水服', contact_email: 'info@tripro.es', email: 'info@tripro.es'
});
var dupRow = srow({
  company: 'Costa Neoprene Copy', domain: 'costaneoprene.es', website: 'https://costaneoprene.es', country: '西班牙',
  evidence_url: 'https://costaneoprene.es/shop', evidence_excerpt: 'Neoprene wetsuits, custom wetsuits.',
  product_category: '潜水服', contact_email: 'copy@costaneoprene.es', email: 'copy@costaneoprene.es'
});
var fResult = P.processProspectImport(P.normalizeProspectSearchCompanies([strong, triRow, dupRow]), [], []);
check('(f) 搜索行入池 1 条', fResult.pooled.length === 1 && fResult.rejected.length === 1 && fResult.skipped.length === 1, JSON.stringify({ pooled: fResult.pooled.length, rejected: fResult.rejected.length, skipped: fResult.skipped.length }));
check('(f) 主营三铁行被淘汰', /三铁/.test(fResult.rejected[0].reason), JSON.stringify(fResult.rejected[0]));
check('(f) 本批重复域名跳过', /本批/.test(fResult.skipped[0].reason), JSON.stringify(fResult.skipped[0]));
check('(f) 入池记录含公司/域名', fResult.pooled[0].company === 'Costa Neoprene SL' && fResult.pooled[0].domain === 'costaneoprene.es', JSON.stringify(fResult.pooled[0]));
check('(f) 入池记录满分优先', fResult.pooled[0].score_total === 100 && P.scoreBand(fResult.pooled[0].score_total) === '优先', JSON.stringify(fResult.pooled[0]));
var covHit = P.findProspectCoverageHit('西班牙', '定制潜水服', [{ country: '西班牙', keyword_group: '定制潜水服', run_at: '2026-11-21T10:00:00.000Z' }]);
var covMiss = P.findProspectCoverageHit('西班牙', '冲浪潜水服', [{ country: '西班牙', keyword_group: '定制潜水服', run_at: '2026-11-21T10:00:00.000Z' }]);
check('(f) 覆盖记忆：同国家+关键词组命中、不同组合不命中', !!covHit && !covMiss, JSON.stringify({ hit: !!covHit, miss: !!covMiss }));

console.log('— ' + passed + ' 通过，' + failed + ' 失败（共 ' + (passed + failed) + ' 项）');
process.exit(failed ? 1 : 0);
