import { describe, expect, it } from 'vitest';
import { sendTelegramMessage } from '../src/telegram.js';

function answering(response: Response): typeof fetch {
  return async function respond() {
    return response;
  };
}

describe('sendTelegramMessage', () => {
  it("names Telegram's reason when it refuses the message", async () => {
    const refusal = new Response(
      JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
      { status: 400 },
    );

    await expect(
      sendTelegramMessage({
        botToken: 'secret-token',
        chatId: '42',
        text: 'alert',
        fetchImplementation: answering(refusal),
      }),
    ).rejects.toThrow('Telegram sendMessage answered 400: Bad Request: chat not found');
  });

  it('still names the status when the refusal is not JSON', async () => {
    await expect(
      sendTelegramMessage({
        botToken: 'secret-token',
        chatId: '42',
        text: 'alert',
        fetchImplementation: answering(new Response('<html>bad gateway</html>', { status: 502 })),
      }),
    ).rejects.toThrow('Telegram sendMessage answered 502: no reason given');
  });

  it('keeps the bot token out of the error', async () => {
    const refusal = new Response(JSON.stringify({ description: 'Unauthorized' }), { status: 401 });

    const error = await sendTelegramMessage({
      botToken: 'secret-token',
      chatId: '42',
      text: 'alert',
      fetchImplementation: answering(refusal),
    }).catch((caught: unknown) => caught);

    expect(String(error)).not.toContain('secret-token');
  });
});
