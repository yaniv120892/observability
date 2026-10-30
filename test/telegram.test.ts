import { describe, expect, it } from 'vitest';
import { sendTelegramMessage, sendTelegramPhoto } from '../src/telegram.js';
import { createRecordingFetch } from './fakes/recording-fetch.js';

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

describe('sendTelegramPhoto', () => {
  it('uploads the picture as multipart form data to the chat', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();

    await sendTelegramPhoto({
      botToken: 'secret-token',
      chatId: '42',
      photo: new Uint8Array([1, 2, 3]),
      fileName: 'weekly-report.png',
      fetchImplementation,
    });

    const [request] = requests;
    expect(request?.url).toBe('https://api.telegram.org/botsecret-token/sendPhoto');
    const form = request?.init?.body;
    if (!(form instanceof FormData)) {
      throw new Error('Expected a FormData body');
    }
    expect(form.get('chat_id')).toBe('42');
    const photo = form.get('photo');
    if (!(photo instanceof File)) {
      throw new Error('Expected the photo as a file');
    }
    expect(photo.name).toBe('weekly-report.png');
    expect([...new Uint8Array(await photo.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("names Telegram's reason when it refuses the photo", async () => {
    const refusal = new Response(JSON.stringify({ description: 'Bad Request: chat not found' }), {
      status: 400,
    });

    await expect(
      sendTelegramPhoto({
        botToken: 'secret-token',
        chatId: '42',
        photo: new Uint8Array([1]),
        fileName: 'weekly-report.png',
        fetchImplementation: answering(refusal),
      }),
    ).rejects.toThrow('Telegram sendPhoto answered 400: Bad Request: chat not found');
  });
});
