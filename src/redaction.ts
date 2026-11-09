import { createHash } from 'node:crypto';

export const REDACTED = '[redacted]';

/** The `key`, `*.key` and `*.*.key` depths, arrays counting as one. */
const REDACTION_DEPTH = 3;

const PSEUDONYM_PREFIX = 'sha256:';
const PSEUDONYM_LENGTH = 12;

/** Keys can be dynamic (an id used as a key), so the memo of judged keys stops growing here. */
const MAX_JUDGED_KEYS = 1000;

/**
 * Matched against a key's last word, or its last two words joined: `x-api-key`, `inviteCode`.
 * A word ending in `token`, `secret` or `password` matches through `SECRET_SUFFIXES` instead.
 */
const SECRET_NAMES = new Set([
  'passwd',
  'passphrase',
  'authorization',
  'authcode',
  'bearer',
  'cookie',
  'cookies',
  'otp',
  'totp',
  'jwt',
  'credential',
  'credentials',
  'apikey',
  'apikeys',
  'accesskey',
  'secretkey',
  'privatekey',
  'signingkey',
  'invitecode',
  'dsn',
  'connectionstring',
  'databaseurl',
]);
/** A lower-case compound such as `accesstoken` or `clientsecret` has no word boundary to split on. */
const SECRET_SUFFIXES = ['token', 'secret', 'password'];
/** Words that name the form a secret takes after its name: `otpCode`, `passwordHash`, `keyPem`. */
const SECRET_FORMS = new Set(['code', 'hash', 'value', 'header', 'string', 'pem']);

const CONTACT_NAMES = new Set(['email', 'phone', 'mobile']);
const CONTACT_FORMS = new Set(['address', 'number']);
/** Also a range's end or a redirect's target, so its value is hashed only when it is an address. */
const RECIPIENT_KEYS = new Set(['to']);
const INTERNATIONAL_PHONE = /^\+\d[\d\s().-]{6,}$/;

type KeyTreatment = 'redact' | 'pseudonymize' | 'pseudonymize-recipient' | 'walk';

type RedactionRules = { secretKeys: Set<string>; judgedKeys: Map<string, KeyTreatment> };

/**
 * A copy of `object` with secrets censored and contact details (an email, a phone, an address in
 * `to`) replaced by a short stable hash, so one person's records still correlate. A key is judged
 * by its words, whatever its case or separators, so `refreshToken`, `x-api-key` and `OTP_CODE` are
 * secrets while `statusCode` and `tokenCount` are not; a boolean under a secret's name, such as
 * `hasPassword`, is kept. `secretKeys` adds exact names, in any case.
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
): (object: object) => Record<string, unknown> {
  const rules = rulesFor(secretKeys);
  return function redact(object) {
    return redactEntries({ object, rules, depth: 0 });
  };
}

function rulesFor(secretKeys: string[]): RedactionRules {
  return { secretKeys: new Set(secretKeys.map((key) => key.toLowerCase())), judgedKeys: new Map() };
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
      return typeof value === 'boolean' || value === null || value === undefined ? value : REDACTED;
    case 'pseudonymize':
      return pseudonymized({ value, rules, depth, isAddress: isHashable });
    case 'pseudonymize-recipient':
      return pseudonymized({ value, rules, depth, isAddress: isAddressLike });
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
  if (isWalkable(value)) {
    return redactEntries({ object: value, rules, depth });
  }
  return value;
}

function pseudonymized({
  value,
  rules,
  depth,
  isAddress,
}: {
  value: unknown;
  rules: RedactionRules;
  depth: number;
  isAddress: (value: unknown) => value is string | number;
}): unknown {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => pseudonymized({ value: item, rules, depth, isAddress }));
  }
  if (isAddress(value)) {
    return pseudonymOf(String(value));
  }
  return redactNested({ value, rules, depth: depth + 1 });
}

function isHashable(value: unknown): value is string | number {
  return (typeof value === 'string' && value.trim() !== '') || typeof value === 'number';
}

function isAddressLike(value: unknown): value is string {
  return (
    typeof value === 'string' && (value.includes('@') || INTERNATIONAL_PHONE.test(value.trim()))
  );
}

function pseudonymOf(value: string): string {
  const digest = createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
  return `${PSEUDONYM_PREFIX}${digest.slice(0, PSEUDONYM_LENGTH)}`;
}

function treatmentOf({ key, rules }: { key: string; rules: RedactionRules }): KeyTreatment {
  const judged = rules.judgedKeys.get(key);
  if (judged) {
    return judged;
  }
  const treatment = judge({ key, secretKeys: rules.secretKeys });
  if (rules.judgedKeys.size < MAX_JUDGED_KEYS) {
    rules.judgedKeys.set(key, treatment);
  }
  return treatment;
}

function judge({ key, secretKeys }: { key: string; secretKeys: Set<string> }): KeyTreatment {
  const lowerKey = key.toLowerCase();
  const words = wordsOf(key);
  if (secretKeys.has(lowerKey) || namesSecret(words)) {
    return 'redact';
  }
  if (namesContact(words)) {
    return 'pseudonymize';
  }
  return RECIPIENT_KEYS.has(lowerKey) ? 'pseudonymize-recipient' : 'walk';
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
  const withoutForm = withoutTrailing({ words, forms: SECRET_FORMS });
  return endsInSecretName(words) || (withoutForm !== words && endsInSecretName(withoutForm));
}

function endsInSecretName(words: string[]): boolean {
  const lastWord = words.at(-1) ?? '';
  return (
    SECRET_NAMES.has(lastWord) ||
    SECRET_NAMES.has(words.slice(-2).join('')) ||
    SECRET_SUFFIXES.some((suffix) => lastWord.endsWith(suffix))
  );
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

/**
 * A plain object, or a class instance that serializes as its own fields. An Error, a Map or a
 * Set, and anything with `toJSON` (a Date, a URL, a Buffer), keeps its class, so a sink still
 * serializes it as one; a logged error's fields are redacted by the logger's `err` serializer.
 */
function isWalkable(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const keepsItsClass =
    value instanceof Error ||
    value instanceof Map ||
    value instanceof Set ||
    ('toJSON' in value && typeof value.toJSON === 'function');
  return !keepsItsClass;
}
