# 012 — Rate-limit sign-in attempts

**Status:** shipped

## TL;DR

Sign-in has no limit on attempts, so a password can be guessed at line speed. Limit failed
attempts per account and per IP address with a fixed window kept in the existing Redis instance,
and answer a limited request with `429` and a `Retry-After` header. Successful sign-ins are never
counted.

**Where to look:**

- High-level scope: `## What`
- File-level scope: `## Where`
- Per-requirement detail: `## Requirements`
- Non-negotiables: `## Constraints`

## Reuse check

- Searched: `rg -n "rateLimit|429|Retry-After" src/` found `src/lib/rate-limit.ts`, used by
  `POST /api/contact`; `rg -n "redis" src/lib` found `src/lib/redis.ts`.
- Reuse as-is: `rate-limit.ts`, no. It keys by IP only, and an account needs its own counter so a
  botnet cannot spread guesses across addresses.
- Extend to reuse: `rate-limit.ts`, yes. One optional `key` parameter lets callers pass their own
  key; the contact form keeps its default.
- Building new is justified because: nothing new is built. The limiter is extended.

## What

Limit failed sign-in attempts to 5 per account and 20 per IP address in any 15-minute window,
using the existing limiter extended with a caller-supplied key.

## Dependencies

N/A

## Where

Changed files:

- `src/lib/rate-limit.ts` — accept an optional `key` and a `count` predicate.
- `src/app/api/sign-in/route.ts` — check both limits before verifying the password; count only
  failures.
- `test/sign-in.test.ts` — cover the limits, the reset and the response.

## Requirements

1. The sixth failed attempt for one account within 15 minutes returns `429`.
2. The twenty-first failed attempt from one IP within 15 minutes returns `429`, whatever accounts
   it names.
3. A `429` carries `Retry-After` with the seconds left in the window.
4. A successful sign-in is not counted and does not reset the counters.
5. The response body for a limited request is the same whether or not the account exists.

## Constraints

- No new dependency. The limiter and Redis client exist.
- Rejected: a sliding window. It is fairer at the boundary but needs a sorted set per key, and the
  fixed window's worst case (10 attempts across a boundary) is acceptable here.
- Rejected: CAPTCHA after three failures. It adds a third-party script to the sign-in page, which
  the privacy canon does not allow without a decision of its own.

## Edge cases

- Redis unavailable: fail open and log, so an outage does not lock everyone out.
- An email in a different case counts as the same account: the key is the normalised email.

## Interfaces and data

`POST /api/sign-in` can now return `429` with `Retry-After`. Redis keys
`rl:sign-in:acct:<sha256(email)>` and `rl:sign-in:ip:<ip>`, both expiring after the window.

## Out of scope

Lockout notifications by email. Limits on password reset.

## Decisions

| Question                          | Answer                                                            | By                  |
| --------------------------------- | ----------------------------------------------------------------- | ------------------- |
| Limits per account and per IP     | 5 and 20 per 15 minutes; the IP limit stops spraying across users | Ada                 |
| Fail open or closed without Redis | Open, and log: a Redis outage must not stop every sign-in         | Ada                 |
| Hash the email in the key         | Yes, so Redis holds no addresses                                  | Claude, recommended |

## Still open

None.

## Verification

- `pnpm test test/sign-in.test.ts` covers requirements 1 to 5.
- Manually: six wrong passwords for one account return `429` with `Retry-After` (1, 3).
