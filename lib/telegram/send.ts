import 'server-only';

/**
 * 텔레그램 Bot API 클라이언트.
 *
 * 봇 토큰과 채널 ID 는 환경변수로 받는다. 둘 중 하나라도 없으면 **조용히 꺼진 상태**로
 * 둔다 — 마케팅 채널은 준비되기 전에 저절로 켜지면 안 된다.
 */

const API = 'https://api.telegram.org';

export class TelegramError extends Error {}

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * 채널에 글을 보낸다.
 *
 * `disable_web_page_preview` 를 끄지 않는다 — 사이트 링크 미리보기가 뜨는 편이
 * 클릭률에 낫다. 대신 og 이미지가 없으면 밋밋하므로 그건 별도 과제다.
 */
export async function sendMessage(html: string): Promise<{ messageId: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new TelegramError('TELEGRAM_BOT_TOKEN 과 TELEGRAM_CHAT_ID 가 필요합니다.');
  }

  const response = await fetch(`${API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { prefer_small_media: true },
    }),
  });

  const payload = (await response.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
    error_code?: number;
  };

  if (!payload.ok || !payload.result) {
    // 텔레그램은 실패 사유를 description 에 담아 준다. 그대로 남겨야 고칠 수 있다 —
    // 흔한 것: "chat not found"(채널에 봇 미초대), "can't parse entities"(HTML 오류).
    throw new TelegramError(
      `텔레그램 전송 실패 (${payload.error_code ?? response.status}): ${payload.description ?? '알 수 없음'}`,
    );
  }

  return { messageId: payload.result.message_id };
}

/** 봇과 채널 연결이 살아 있는지 확인한다. 발송 전에 한 번 불러 본다. */
export async function checkConnection(): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramError('TELEGRAM_BOT_TOKEN 이 없습니다.');

  const response = await fetch(`${API}/bot${token}/getMe`);
  const payload = (await response.json()) as {
    ok: boolean;
    result?: { username: string };
    description?: string;
  };
  if (!payload.ok || !payload.result) {
    throw new TelegramError(`봇 확인 실패: ${payload.description ?? response.status}`);
  }
  return payload.result.username;
}
