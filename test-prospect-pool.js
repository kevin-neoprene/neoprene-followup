// 搜客池 Phase 1 冒烟测试（本地跑，不碰真实数据库）：
//   node test-prospect-pool.js
// 覆盖：(a) 强候选 ≥80 分；(b) 工业用途硬淘汰；(c) 日本/中国硬淘汰；
//   (d) 对客户档案的域名/邮箱/公司名三重去重；(e) <40 分自动淘汰；
//   (f) 门槛是顶部常量；(g) 列名自动识别（中英文同义词）+ 整批清洗流程。
var P = require('./app.js');

var passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}
function row(o) {
  return Object.assign({
    company: '', domain: '', website: '', country: '', size_text: '',
    evidence_url: '', evidence_excerpt: '', evidence_level: '',
    product_category: '', industry: '', oem_text: '', activity_text: '',
    contact_name: '', contact_role: '', contact_email: '', email: '',
    phone: '', whatsapp: ''
  }, o);
}

// (a) 强候选 ≥80 分：官网在售 35 + 正好是潜水服 20 + OEM 15 + 具名 CEO 邮箱 15 + 11-200 人 10 + 邮箱+电话 5 = 100
var strong = row({
  company: 'Mediterranean Wetsuits SL', domain: 'medwetsuits.es', website: 'https://medwetsuits.es',
  country: '西班牙', size_text: '50-100 人',
  evidence_url: 'https://medwetsuits.es/shop', evidence_excerpt: 'Our neoprene wetsuits are made from 3mm CR chloroprene, buy now in our online shop.',
  evidence_level: 'site_sale', product_category: '潜水服', oem_text: 'custom OEM wetsuits, private label',
  contact_name: 'Carlos Ruiz', contact_role: 'CEO', contact_email: 'carlos@medwetsuits.es', phone: '+34 600 123 456'
});
var hardStrong = P.checkProspectHardRules(strong);
check('(a) 强候选过硬规则', hardStrong.ok === true, JSON.stringify(hardStrong));
var sigStrong = P.detectProspectSignals(strong);
var scStrong = P.scoreProspect(sigStrong);
check('(a) 强候选总分 100', scStrong.total === 100, 'got ' + scStrong.total + ' ' + JSON.stringify(scStrong.parts));
check('(a) 强候选分档 优先', P.scoreBand(scStrong.total) === '优先');
check('(a) 强候选定档 待复核', P.classifyProspect(scStrong.total, '').status === '待复核');

// (b) 工业用途硬淘汰：证据明确也淘汰
var industrial = row({
  company: 'Industrial Rubber GmbH', domain: 'industrial-rubber.de', website: 'https://industrial-rubber.de',
  country: '德国', size_text: '100-200 人',
  evidence_url: 'https://industrial-rubber.de/neoprene', evidence_excerpt: 'Neoprene gaskets and seals for industrial applications, chemical plant pipeline insulation.',
  product_category: '密封件', industry: '工业',
  contact_name: 'Hans Meyer', contact_role: 'CEO', contact_email: 'hans@industrial-rubber.de', phone: '+49 30 123456'
});
var hardInd = P.checkProspectHardRules(industrial);
check('(b) 工业用途硬淘汰', hardInd.ok === false && /工业/.test(hardInd.reason), JSON.stringify(hardInd));

// (b2) 三铁方向硬淘汰（PDF 第 5 页）
var tri = row({
  company: 'Triathlon Gear Co', domain: 'trishop.com', website: 'https://trishop.com',
  country: '美国', size_text: '20-50 人',
  evidence_url: 'https://trishop.com/neoprene', evidence_excerpt: 'Neoprene triathlon wetsuits for open water racing.',
  product_category: '潜水服',
  contact_name: 'Ann Lee', contact_role: 'Founder', contact_email: 'ann@trishop.com'
});
var hardTri = P.checkProspectHardRules(tri);
check('(b2) 三铁方向硬淘汰', hardTri.ok === false && /三铁/.test(hardTri.reason), JSON.stringify(hardTri));

// (c) 日本/中国硬淘汰：国家名、域名后缀两道
var japan = row({
  company: 'Osaka Wetsuits KK', domain: 'osaka-wetsuits.jp', website: 'https://osaka-wetsuits.jp',
  country: '日本', size_text: '30-80 人',
  evidence_url: 'https://osaka-wetsuits.jp/', evidence_excerpt: 'Neoprene wetsuits made in Japan.',
  product_category: '潜水服', contact_name: 'Taro Yamada', contact_role: 'CEO', contact_email: 'taro@osaka-wetsuits.jp'
});
check('(c) 日本硬淘汰', P.checkProspectHardRules(japan).ok === false);
var chinaDomain = row({
  company: 'Shenzhen Neo Co', domain: 'szneo.cn', website: 'https://szneo.cn',
  country: '', size_text: '50-100 人',
  evidence_url: 'https://szneo.cn/', evidence_excerpt: 'Neoprene sheets CR SBR for wetsuits.',
  product_category: '潜水料片材', contact_name: 'Li Wei', contact_role: 'CEO', contact_email: 'li@szneo.cn'
});
var hardCn = P.checkProspectHardRules(chinaDomain);
check('(c) 中国域名后缀硬淘汰', hardCn.ok === false && /后缀/.test(hardCn.reason), JSON.stringify(hardCn));
var hk = row({
  company: 'HK Neo Trading', domain: 'hkneo.com.hk', website: 'https://hkneo.com.hk',
  country: '香港', size_text: '10-20 人',
  evidence_url: 'https://hkneo.com.hk/', evidence_excerpt: 'Neoprene products wholesale.',
  product_category: '包袋', contact_name: 'Chan', contact_role: 'Owner', contact_email: 'chan@hkneo.com.hk'
});
check('(c) 香港硬淘汰', P.checkProspectHardRules(hk).ok === false);

// (d) 去重三重检查（对客户档案 + 搜客池含已淘汰）
//   客户档案里已有 FetchMate（fetchmaate@gmail.com，免费域名 gmail 不算域名去重）。
var customers = [
  { email: 'fetchmaate@gmail.com', company: 'FetchMate', website: '', country: '' },
  { email: 'matt@turnbullstrategy.com', company: 'Turnbull Strategy', website: 'https://turnbullstrategy.com', country: '美国' },
  { email: 'info@boardsox.com.au', company: 'Boardsox Pty LTD', website: 'https://boardsox.com.au', country: '澳大利亚' }
];
var candidates = [
  { company: 'Discarded Wetsuits SL', domain: 'discarded.es', website: 'https://discarded.es', country: '西班牙', contact_email: 'info@discarded.es', status: '已淘汰' }
];
var dupEmail = row({ company: 'FetchMate', domain: 'fetchmate.com', country: '美国', evidence_excerpt: 'Neoprene pet products.', product_category: '宠物用品', contact_email: 'fetchmaate@gmail.com' });
var d1 = P.findProspectDuplicate(dupEmail, customers, candidates);
check('(d) 邮箱相同命中客户档案', d1 && d1.where === '客户档案' && d1.kind === '邮箱', JSON.stringify(d1));
var dupDomain = row({ company: 'Turnbull Gear', domain: 'turnbullstrategy.com', country: '美国', evidence_excerpt: 'Neoprene wetsuits.', product_category: '潜水服', contact_email: 'someone@other.com' });
var d2 = P.findProspectDuplicate(dupDomain, customers, candidates);
check('(d) 域名相同命中客户档案', d2 && d2.where === '客户档案' && d2.kind === '域名', JSON.stringify(d2));
var dupEmailDom = row({ company: 'Boardsox Gear', domain: 'boardsox-gear.com', country: '澳大利亚', evidence_excerpt: 'Neoprene wetsuit bags.', product_category: '包袋', contact_email: 'sarah@boardsox.com.au' });
var d3 = P.findProspectDuplicate(dupEmailDom, customers, candidates);
check('(d) 非免费邮箱域名相同命中', d3 && d3.kind === '邮箱域名', JSON.stringify(d3));
var dupDiscarded = row({ company: 'Discarded Wetsuits SL', domain: 'discarded.es', country: '西班牙', evidence_excerpt: 'Neoprene wetsuits.', product_category: '潜水服', contact_email: 'new@discarded.es' });
var d4 = P.findProspectDuplicate(dupDiscarded, customers, candidates);
check('(d) 已淘汰的候选域名仍命中搜客池', d4 && d4.where === '搜客池' && d4.kind === '域名', JSON.stringify(d4));
// 免费邮箱域名不算域名去重：同 gmail.com 不同公司不命中
var freeMail = row({ company: 'Unrelated Shop', domain: 'unrelated-shop.com', country: '美国', evidence_excerpt: 'Neoprene bags.', product_category: '包袋', contact_email: 'someone@gmail.com' });
check('(d) 免费邮箱域名不算去重', P.findProspectDuplicate(freeMail, customers, candidates) === null);
// 公司名相同但国家不同不命中
var diffCountry = row({ company: 'Boardsox Pty LTD', domain: 'boardsox-eu.com', country: '德国', evidence_excerpt: 'Neoprene wetsuits.', product_category: '潜水服', contact_email: 'eu@boardsox-eu.com' });
check('(d) 同名不同国家不命中', P.findProspectDuplicate(diffCountry, customers, candidates) === null);

// (e) <40 分自动淘汰：博客证据 10 + 相邻品类 10 + 只有零售 5 + 无邮箱 0 + 规模 7 + 无联系方式 0 = 32
var weak = row({
  company: 'Yoga Blog Shop', domain: 'yogablogshop.fr', website: 'https://yogablogshop.fr',
  country: '法国', size_text: '5-10 人',
  evidence_url: 'https://yogablogshop.fr/blog/neoprene', evidence_excerpt: 'Our blog reviews neoprene yoga mats.',
  evidence_level: 'blog', product_category: '瑜伽垫', oem_text: 'retail store only',
  contact_name: '', contact_role: '', contact_email: '', phone: ''
});
check('(e) 弱候选过硬规则（有证据、民用、法国）', P.checkProspectHardRules(weak).ok === true);
var scWeak = P.scoreProspect(P.detectProspectSignals(weak));
check('(e) 弱候选总分 32', scWeak.total === 32, 'got ' + scWeak.total + ' ' + JSON.stringify(scWeak.parts));
check('(e) 弱候选分档 淘汰', P.scoreBand(scWeak.total) === '淘汰');
var clsWeak = P.classifyProspect(scWeak.total, '');
check('(e) 弱候选定档 已淘汰并带原因', clsWeak.status === '已淘汰' && !!clsWeak.reason, JSON.stringify(clsWeak));

// (f) 门槛是顶部常量
check('(f) SCORE_REVIEW_MIN=60', P.SCORE_REVIEW_MIN === 60);
check('(f) SCORE_DISCARD_MAX=40', P.SCORE_DISCARD_MAX === 40);
check('(f) SCORE_PRIORITY_MIN=80', P.SCORE_PRIORITY_MIN === 80);

// (g) 列名自动识别 + 整批清洗流程
var mapping = P.detectProspectColumns(['公司', '域名', '国家', '规模', '邮箱', '联系人', '职位', '证据链接', '证据摘录', '证据位置', '产品类别']);
check('(g) 中文表头识别', mapping.company === '公司' && mapping.domain === '域名' && mapping.evidence_level === '证据位置', JSON.stringify(mapping));
var mappingEn = P.detectProspectColumns(['Company', 'Domain', 'Country', 'Size', 'Email', 'Contact', 'Title', 'Evidence', 'Excerpt', 'Product']);
check('(g) 英文表头识别', mappingEn.company === 'Company' && mappingEn.domain === 'Domain' && mappingEn.product_category === 'Product', JSON.stringify(mappingEn));
var batch = P.processProspectImport(
  [strong, industrial, japan, dupEmail, weak].map(function (r) { return r; }),
  customers, candidates
);
check('(g) 整批：入池 1 条（强候选）', batch.pooled.length === 1, 'got ' + batch.pooled.length);
check('(g) 整批：淘汰 3 条（工业/日本/弱候选）', batch.rejected.length === 3, 'got ' + batch.rejected.length + ' ' + JSON.stringify(batch.rejected.map(function (x) { return x.reason; })));
check('(g) 整批：跳过 1 条（FetchMate 邮箱重复）', batch.skipped.length === 1, 'got ' + batch.skipped.length);
check('(g) 入池记录含分项分', batch.pooled[0] && batch.pooled[0].score_total === 100 && batch.pooled[0].score_evidence === 35 && batch.pooled[0].status === '待复核', JSON.stringify(batch.pooled[0] && { t: batch.pooled[0].score_total, s: batch.pooled[0].status }));
// 覆盖记忆判重
var cov = [{ country: '西班牙', keyword_group: '潜水服', domains_seen: ['medwetsuits.es'], searched_at: '2026-11-21T00:00:00Z' }];
check('(g) 覆盖记忆命中同一组合', !!P.findProspectCoverageHit('西班牙', '潜水服', cov));
check('(g) 覆盖记忆不同组合不命中', P.findProspectCoverageHit('法国', '潜水服', cov) === null);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
