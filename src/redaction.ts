import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';

/** The `key`, `*.key` and `*.*.key` depths, arrays counting as one. */
const REDACTION_DEPTH = 3;

const PSEUDONYM_PREFIX = 'sha256:';
const PSEUDONYM_LENGTH = 12;

/** Matched against a key's last word, or its last two words joined: `x-api-key`, `inviteCode`. */
const SECRET_NAMES = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'cookie',
  'cookies',
  'otp',
  'totp',
  'jwt',
  'credential',
  'credentials',
  'apikey',
  'accesskey',
  'secretkey',
  'privatekey',
  'signingkey',
  'invitecode',
]);
/** A lower-case compound such as `accesstoken` or `clientsecret` has no word boundary to split on. */
const SECRET_SUFFIXES = ['token', 'secret', 'password'];
/** Words that name the form a secret takes after its name: `otpCode`, `passwordHash`, `tokenValue`. */
const SECRET_FORMS = new Set(['code', 'hash', 'value', 'header', 'string']);

const CONTACT_NAMES = new Set(['email', 'phone', 'mobile']);
const CONTACT_FORMS = new Set(['address', 'number']);
const CONTACT_KEYS = new Set(['to']);

type RedactionRules = { secretKeys: Set<string> };

type KeyTreatment = 'redact' | 'pseudonymize' | 'walk';

/**
 * A copy of `object` with secrets censored and contact details (an email, a phone, a `to`)
 * replaced by a short stable hash, so one person's records still correlate. A key is judged by
 * its words, whatever its case or separators, so `refreshToken`, `x-api-key` and `OTP_CODE` are
 * secrets while `statusCode` and `tokenCount` are not. `secretKeys` adds exact names, in any case.
 */
export function redactSecrets({
  context,
  secretKeys = [],
}: {
  context: Record<string, unknown>;
  secretKeys?: string[];
}): Record<string, unknown> {
  return redactEntries({ object: context, rules: rulesFor(secretKeys), depth: 0 });
}

/** The same censoring, built once, for a sink that redacts every record it writes. */
export function createRedactor(
  secretKeys: string[] = [],
): (object: Record<string, unknown>) => Record<string, unknown> {
  const rules = rulesFor(secretKeys);
  return function redact(object) {
    return redactEntries({ object, rules, depth: 0 });
  };
}

function rulesFor(secretKeys: string[]): RedactionRules {
  return { secretKeys: new Set(secretKeys.map((key) => key.toLowerCase())) };
}

function redactEntries({
  object,
  rules,
  depth,
}: {
  object: object;
  rules: RedactionRules;
  depth: number;
}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      redactEntry({ treatment: treatmentOf({ key, rules }), value, rules, depth }),
    ]),
  );
}

function redactEntry({
  treatment,
  value,
  rules,
  depth,
}: {
  treatment: KeyTreatment;
  value: unknown;
  rules: RedactionRules;
  depth: number;
}): unknown {
  switch (treatment) {
    case 'redact':
      return REDACTED;
    case 'pseudonymize':
      return pseudonymized({ value, rules, depth });
    default:
      return redactNested({ value, rules, depth: depth + 1 });
  }
}

function redactNested({
  value,
  rules,
  depth,
}: {
  value: unknown;
  rules: RedactionRules;
  depth: number;
}): unknown {
  if (depth >= REDACTION_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactNested({ value: item, rules, depth: depth + 1 }));
  }
  // A Date, Error or URL keeps its class, so a sink still serializes it as one.
  if (isPlainObject(value)) {
    return redactEntries({ object: value, rules, depth });
  }
  return value;
}

function pseudonymized({
  value,
  rules,
  depth,
}: {
  value: unknown;
  rules: RedactionRules;
  depth: number;
}): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => pseudonymized({ value: item, rules, depth }));
  }
  const isHashable =
    (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';
  if (isHashable) {
    return pseudonymOf(String(value));
  }
  return redactNested({ value, rules, depth: depth + 1 });
}

function pseudonymOf(value: string): string {
  const digest = createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  return `${PSEUDONYM_PREFIX}${digest.slice(0, PSEUDONYM_LENGTH)}`;
}

function treatmentOf({ key, rules }: { key: string; rules: RedactionRules }): KeyTreatment {
  if (rules.secretKeys.has(key.toLowerCase())) {
    return 'redact';
  }
  const words = wordsOf(key);
  if (namesSecret(words)) {
    return 'redact';
  }
  if (CONTACT_KEYS.has(key.toLowerCase()) || namesContact(words)) {
    return 'pseudonymize';
  }
  return 'walk';
}

/** `refreshToken`, `x-api-key` and `OTP_CODE` become `refresh token`, `x api key`, `otp code`. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

function namesSecret(words: string[]): boolean {
  return [words, withoutTrailing({ words, forms: SECRET_FORMS })].some((candidate) => {
    const lastWord = candidate.at(-1) ?? '';
    const lastTwoWords = candidate.slice(-2).join('');
    return (
      SECRET_NAMES.has(lastWord) ||
      SECRET_NAMES.has(lastTwoWords) ||
      SECRET_SUFFIXES.some((suffix) => lastWord.endsWith(suffix))
    );
  });
}

function namesContact(words: string[]): boolean {
  const lastWord = withoutTrailing({ words, forms: CONTACT_FORMS }).at(-1) ?? '';
  return CONTACT_NAMES.has(lastWord);
}

function withoutTrailing({ words, forms }: { words: string[]; forms: Set<string> }): string[] {
  const lastWord = words.at(-1);
  const endsInForm = words.length > 1 && lastWord !== undefined && forms.has(lastWord);
  return endsInForm ? words.slice(0, -1) : words;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
