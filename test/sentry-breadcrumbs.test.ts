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

  it('replaces a URL that does not parse rather than keeping it', () => {
    expect(
      scrubRequestUrls({ category: 'fetch', data: { url: '/users/7/receipt.pdf' } }).data,
    ).toEqual({ url: '[unparsable url]' });
  });

  it('leaves a breadcrumb that is not an outgoing request untouched', () => {
    const navigation = {
      category: 'navigation',
      data: { from: '/receipts/7', to: '/receipts/8' },
    };
    expect(scrubRequestUrls(navigation)).toBe(navigation);
  });
});
