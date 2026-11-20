// スレッドでの名前。Agent 本人はコテハン、野次馬は名無し。

export const YAJIUMA_NAME = "風吹けば名無し";
export const NAME_MAX = 24;

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const cut = (s) => Array.from(s).slice(0, NAME_MAX).join("");

/**
 * Agent ごとの名前を決める。space の名前を使い、同じ space に 2 つ以上あれば tab の名前を付ける。
 * @param {{address: string, space: string, space_name: string, tab_name: string}[]} agents
 * @returns {Record<string, string>}
 */
export function agentNames(agents) {
  const perSpace = {};
  for (const a of agents) perSpace[a.space] = (perSpace[a.space] ?? 0) + 1;
  const names = {};
  for (const a of agents) {
    names[a.address] = cut(perSpace[a.space] >= 2 ? `${a.space_name}/${a.tab_name}` : a.space_name);
  }
  return names;
}

/**
 * 野次馬の ID（英数字 5 字）。
 * @param {() => number} rand 0 以上 1 未満の乱数
 */
export function yajiumaId(rand) {
  let id = "";
  for (let i = 0; i < 5; i++) id += ID_CHARS[Math.min(ID_CHARS.length - 1, Math.floor(rand() * ID_CHARS.length))];
  return id;
}
