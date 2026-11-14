// 店铺配置：TB_SHOPS 是 JSON 数组，每家店对应一个紫鸟店铺（store_id）。
//   TB_SHOPS='[{"name":"天猫店","store_id":"12345678901234","default":true},{"name":"淘宝店","store_id":"23456789012345"}]'
// 只有一家店时也可以只设 TB_STORE_ID。工具里的 shop 参数填店铺名或紫鸟店铺 ID，不填 = 默认店。

export class ShopConfigError extends Error {}

const FIELDS = new Set(['name', 'store_id', 'default']);
const STORE_ID = /^\d{5,24}$/;

/** 解析并校验店铺配置；没有配置时返回空数组（调用时仍可直接传 shop=紫鸟店铺 ID） */
export function parseShops(env = process.env) {
  const raw = String(env.TB_SHOPS ?? '').trim();
  if (!raw) {
    const single = String(env.TB_STORE_ID ?? '').trim();
    if (!single) return [];
    if (!STORE_ID.test(single)) throw new ShopConfigError('TB_STORE_ID 应是紫鸟店铺 ID（5–24 位数字）');
    return [{ name: single, storeId: single, isDefault: true }];
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    throw new ShopConfigError(`TB_SHOPS 不是合法 JSON：${err.message}`);
  }
  if (!Array.isArray(list) || !list.length) throw new ShopConfigError('TB_SHOPS 应是非空数组，如 [{"name":"主店","store_id":"12345678901234"}]');
  const names = new Set();
  const ids = new Set();
  const shops = list.map((item, i) => {
    const where = `TB_SHOPS[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ShopConfigError(`${where} 应是对象`);
    for (const key of Object.keys(item)) if (!FIELDS.has(key)) throw new ShopConfigError(`${where} 有未知字段 ${key}（只支持 name、store_id、default）`);
    const storeId = String(item.store_id ?? '').trim();
    if (!STORE_ID.test(storeId)) throw new ShopConfigError(`${where}.store_id 应是紫鸟店铺 ID（5–24 位数字）`);
    const name = String(item.name ?? '').trim() || storeId;
    if (name.length > 40) throw new ShopConfigError(`${where}.name 最多 40 个字`);
    if (item.default !== undefined && typeof item.default !== 'boolean') throw new ShopConfigError(`${where}.default 应是 true / false`);
    if (names.has(name)) throw new ShopConfigError(`店铺名重复：${name}`);
    if (ids.has(storeId)) throw new ShopConfigError(`紫鸟店铺 ID 重复：${storeId}`);
    names.add(name);
    ids.add(storeId);
    return { name, storeId, isDefault: item.default === true };
  });
  const defaults = shops.filter((s) => s.isDefault);
  if (defaults.length > 1) throw new ShopConfigError('TB_SHOPS 里最多一家店 default: true');
  if (!defaults.length) shops[0].isDefault = true;
  return shops;
}

/**
 * 按店铺名或紫鸟店铺 ID 找店；不填用默认店。
 * 没配置店铺时允许直接传紫鸟店铺 ID。
 */
export function resolveShop(shops, ref) {
  const key = String(ref ?? '').trim();
  if (!key) {
    const def = shops.find((s) => s.isDefault);
    if (def) return def;
    throw new ShopConfigError('还没有配置店铺：请设置环境变量 TB_SHOPS（或 TB_STORE_ID），或在调用时传 shop=紫鸟店铺 ID。');
  }
  const found = shops.find((s) => s.name === key || s.storeId === key);
  if (found) return found;
  if (!shops.length && STORE_ID.test(key)) return { name: key, storeId: key, isDefault: false };
  const known = shops.map((s) => s.name).join('、');
  throw new ShopConfigError(known ? `没有找到店铺「${key}」；已配置：${known}` : `「${key}」不是紫鸟店铺 ID`);
}
