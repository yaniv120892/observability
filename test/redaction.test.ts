import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../src/redaction.js';

const PSEUDONYM = /^sha256:[0-9a-f]{12}$/;

describe('redactSecrets', () => {
  it.each([
    'token',
    'accessToken',
    'refresh_token',
    'X-Access-Token',
    'accesstoken',
    'clientSecret',
    'PASSWORD',
    'passwordHash',
    'Authorization',
    'set-cookie',
    'apiKey',
    'x-api-key',
    'API_KEY',
    'otp',
    'otpCode',
    'inviteCode',
    'invite_code',
    'privateKey',
    'credentials',
  ])('redacts %s', (key) => {
    expect(redactSecrets({ context: { [key]: 'plain' } })).toEqual({ [key]: REDACTED });
  });

  it.each([
    'statusCode',
    'errorCode',
    'countryCode',
    'tokenCount',
    'inputTokens',
    'agentTokenId',
    'tokenExpiresAt',
    'secretName',
    'keyPrefix',
    'footprint',
    'hotpath',
    'authorizationUrl',
    'emailVerified',
    'today',
    'toolName',
  ])('keeps %s', (key) => {
    expect(redactSecrets({ context: { [key]: 'plain' } })).toEqual({ [key]: 'plain' });
  });

  it('replaces an email, a phone and a recipient with a short stable hash', () => {
    const redacted = redactSecrets({
      context: {
        email: 'Dana@Example.com ',
        userEmail: 'dana@example.com',
        phoneNumber: '+972501234567',
        to: ['dana@example.com', 'noa@example.com'],
      },
    });
    expect(redacted.email).toMatch(PSEUDONYM);
    expect(redacted.userEmail).toBe(redacted.email);
    expect(redacted.phoneNumber).toMatch(PSEUDONYM);
    expect(redacted.to).toEqual([redacted.email, expect.stringMatching(PSEUDONYM)]);
    expect(JSON.stringify(redacted)).not.toMatch(/example\.com|501234567/);
  });

  it('walks into objects and arrays up to three levels deep', () => {
    expect(
      redactSecrets({
        context: {
          member: { contact: { email: 'dana@example.com' } },
          accounts: [{ apiKey: 'plain' }],
          deep: { one: { two: { token: 'beyond the depth' } } },
        },
      }),
    ).toEqual({
      member: { contact: { email: expect.stringMatching(PSEUDONYM) } },
      accounts: [{ apiKey: REDACTED }],
      deep: { one: { two: { token: 'beyond the depth' } } },
    });
  });

  it('redacts app-specific keys in any case', () => {
    expect(redactSecrets({ context: { SetupCode: 'plain' }, secretKeys: ['setupCode'] })).toEqual({
      SetupCode: REDACTED,
    });
  });
});
