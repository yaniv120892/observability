import { describe, expect, it } from 'vitest';
import { scrubRequestUrls } from '../src/sentry-breadcrumbs.js';

const PRESIGNED_UPLOAD_URL =
  'https://receipts.s3.amazonaws.com/users/7/receipt.pdf?X-Amz-Credential=AKIA&X-Amz-Signature=f00d#part';

describe('scrubRequestUrls', () => {
  it('drops the path, query and fragment of a browser xhr URL and keeps method and status', () => {
    expect(
      scrubRequestUrls({
        category: 'xhr',
        type: 'http',
        data: { method: 'PUT', url: PRESIGNED_UPLOAD_URL, status_code: 200 },
      }),
    ).toEqual({
      category: 'xhr',
      type: 'http',
      data: { method: 'PUT', url: 'https://receipts.s3.amazonaws.com', status_code: 200 },
    });
  });

  it('keeps the body sizes of a fetch breadcrumb and drops every other URL-bearing key', () => {
    const scrubbed = scrubRequestUrls({
      category: 'fetch',
      data: {
        method: 'PUT',
        url: PRESIGNED_UPLOAD_URL,
        'url.full': PRESIGNED_UPLOAD_URL,
        'url.query': 'X-Amz-Signature=f00d',
        request_body_size: 512,
        response_body_size: 0,
      },
    });
    expect(scrubbed.data).toEqual({
      method: 'PUT',
      url: 'https://receipts.s3.amazonaws.com',
      request_body_size: 512,
      response_body_size: 0,
    });
  });

  it('reduces every URL in the message to its origin', () => {
    expect(
      scrubRequestUrls({ category: 'http', message: `DELETE ${PRESIGNED_UPLOAD_URL} failed` })
        .message,
    ).toBe('DELETE https://receipts.s3.amazonaws.com failed');
  });

  it('replaces the request URL in the message even when it is relative', () => {
    expect(
      scrubRequestUrls({
        category: 'fetch',
        message: 'PUT /users/7/receipt.pdf?sig=abc failed',
        data: { url: '/users/7/receipt.pdf?sig=abc' },
      }).message,
    ).toBe('PUT [url without origin] failed');
  });

  it('replaces a relative URL outside a browser rather than keeping it', () => {
    expect(
      scrubRequestUrls({ category: 'fetch', data: { url: '/users/7/receipt.pdf' } }).data,
    ).toEqual({ url: '[url without origin]' });
  });

  it('cuts protocol-relative URLs and keeps the punctuation that follows a URL', () => {
    expect(
      scrubRequestUrls({
        category: 'http',
        message:
          'PUT //receipts.s3.amazonaws.com/users/7/receipt.pdf, then (https://api.example/x?y=1).',
      }).message,
    ).toBe('PUT [url without origin], then (https://api.example).');
  });

  it('scrubs a request recorded under a category of its own', () => {
    expect(
      scrubRequestUrls({ type: 'http', category: 'storage', data: { url: PRESIGNED_UPLOAD_URL } })
        .data,
    ).toEqual({ url: 'https://receipts.s3.amazonaws.com' });
  });

  it('leaves a breadcrumb that is not an outgoing request untouched', () => {
    const navigation = {
      category: 'navigation',
      data: { from: '/receipts/7', to: '/receipts/8' },
    };
    expect(scrubRequestUrls(navigation)).toBe(navigation);
  });
});
