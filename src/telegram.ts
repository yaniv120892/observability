const SEND_TIMEOUT_MS = 5000;
const PHOTO_SEND_TIMEOUT_MS = 20_000;
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Plain text, no `parse_mode`: an error message is arbitrary text, and one stray underscore or
 * asterisk makes Telegram reject a Markdown send outright.
 */
export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  fetchImplementation = fetch,
}: {
  botToken: string;
  chatId: string;
  text: string;
  fetchImplementation?: typeof fetch;
}): Promise<void> {
  const response = await fetchImplementation(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    // The URL carries the bot token, so it stays out of the error; Telegram's
    // reason ("Bad Request: chat not found") is what says how to fix it.
    const reason = await readTelegramReason(response);
    throw new Error(`Telegram sendMessage answered ${response.status}: ${reason}`);
  }
}

export async function sendTelegramPhoto({
  botToken,
  chatId,
  photo,
  fileName,
  fetchImplementation = fetch,
}: {
  botToken: string;
  chatId: string;
  photo: Uint8Array;
  fileName: string;
  fetchImplementation?: typeof fetch;
}): Promise<void> {
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('photo', new Blob([Uint8Array.from(photo)], { type: 'image/png' }), fileName);
  const response = await fetchImplementation(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(PHOTO_SEND_TIMEOUT_MS),
  });
  if (!response.ok) {
    const reason = await readTelegramReason(response);
    throw new Error(`Telegram sendPhoto answered ${response.status}: ${reason}`);
  }
}

async function readTelegramReason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      'description' in body &&
      typeof body.description === 'string'
    ) {
      return body.description;
    }
  } catch {
    // A body that is not JSON (a proxy's error page) has no reason to report.
  }
  return 'no reason given';
}
