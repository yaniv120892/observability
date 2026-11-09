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
    'authCode',
    'apiKeys',
    'connectionString',
    'DATABASE_URL',
    'privateKeyPem',
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

  it('replaces an email, a phone and a recipient address with a short stable hash', () => {
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

  it('keeps a boolean, null or undefined under a secret name', () => {
    expect(
      redactSecrets({ context: { hasPassword: true, token: null, apiKey: undefined } }),
    ).toEqual({ hasPassword: true, token: null, apiKey: undefined });
  });

  it('hashes a to only when it holds an address', () => {
    const redacted = redactSecrets({
      context: {
        email: { to: 'dana@example.com' },
        sms: { to: '+972 50-123-4567' },
        range: { from: '2026-10-01', to: '2026-10-31' },
        redirect: { to: '/login' },
      },
    });
    expect(redacted).toEqual({
      email: { to: expect.stringMatching(PSEUDONYM) },
      sms: { to: expect.stringMatching(PSEUDONYM) },
      range: { from: '2026-10-01', to: '2026-10-31' },
      redirect: { to: '/login' },
    });
  });

  it('walks into a class instance that serializes as its own fields', () => {
    class Credentials {
      public readonly user = 'dana';
      public readonly password = 'plain';
    }
    expect(redactSecrets({ context: { login: new Credentials() } })).toEqual({
      login: { user: 'dana', password: REDACTED },
    });
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
