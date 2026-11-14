// 风控和脱敏的共用判断。
// - isRiskJson：淘宝风控拦截常以 mtop 风格 JSON 返回（HTTP 200）：ret 带 RGV587 / FAIL_SYS_USER_VALIDATE，或 data.url 指向验证页；
//   生意参谋有时包在 content 里。外层、content 都看。
// - redact：给用户看的错误信息里去掉链接、邮箱、像 ID 的长串（服务端原文可能带卖家加密 ID、内部地址）。

const RISK_CODE = /RGV587|FAIL_SYS_USER_VALIDATE/;
const RISK_URL = /_____tmd_____|\/punish\b|x5secdata/;

function one(j) {
  if (!j || typeof j !== 'object') return false;
  const ret = Array.isArray(j.ret) ? j.ret.join(';') : typeof j.ret === 'string' ? j.ret : '';
  const url = typeof j.data?.url === 'string' ? j.data.url : typeof j.url === 'string' ? j.url : '';
  return RISK_CODE.test(ret) || RISK_URL.test(url);
}

export function isRiskJson(json) {
  return one(json) || one(json?.content);
}

/** 文本里有没有风控信号（错误码、验证页地址、验证提示） */
export const hasRiskText = (s) => RISK_CODE.test(String(s ?? '')) || RISK_URL.test(String(s ?? '')) || /punish|captcha|验证码|安全验证|滑块|人机验证/i.test(String(s ?? ''));

/** 把一个错误对象里所有可能的提示拼起来再判断（错误码和文案分开放时，只看一个会漏掉风控码） */
export const riskInObject = (o) => isRiskJson(o) || hasRiskText([o?.errorCode, o?.errorMsg, o?.errorMessage, o?.msg?.globalMessage?.text, o?.message, o?.code]
  .filter((x) => typeof x === 'string').join(' '));

export function redact(msg, max = 120) {
  return String(msg ?? '')
    .replace(/https?:\/\/\S+|\/\/[\w.-]+\.\w+\/\S*/g, '[链接]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱]')
    .replace(/(?=[A-Za-z0-9_=+/-]*\d)[A-Za-z0-9_=+/-]{10,}|[A-Za-z0-9_=+/-]{20,}/g, '[ID]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
